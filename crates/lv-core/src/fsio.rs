//! Lectura y escritura de los archivos de texto del proyecto, preservando EOL y BOM.
//!
//! La regla es que guardar un archivo sin tocar una línea no puede cambiar los bytes de esa línea. Por eso:
//! - Al leer se detecta el BOM y el EOL y el texto sube normalizado a `\n` (CodeMirror trabaja con `\n`).
//! - Al escribir se detectan el BOM y el EOL **del archivo que hay en disco en ese momento** y se restauran. No se
//!   le pide al llamador que los devuelva, y si otro programa cambió el EOL entre la lectura y el guardado se sigue
//!   al disco.
//! - Si el contenido nuevo es idéntico byte a byte al del disco no se escribe nada: no se toca el mtime, que es lo
//!   que latexmk mira para decidir si hay que recompilar.
//! - Un archivo con EOL mezclados no se puede guardar "como estaba" sin conservar el EOL de cada línea, y el
//!   editor sólo conoce el texto normalizado. Se marca `mixed` y la interfaz lo abre en sólo lectura hasta que el
//!   usuario acepte normalizarlo.
//!
//! Los archivos que no son UTF-8 (UTF-16, binarios, UTF-8 inválido) se rechazan: abrirlos con pérdida y guardarlos
//! los rompería.

use crate::error::{Error, Result};
use md5::{Digest, Md5};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
}

impl Eol {
    fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
            Eol::Cr => "\r",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub eol: Eol,
    pub bom: bool,
    /// Hay más de un tipo de salto de línea (un CR suelto dentro de un CRLF cuenta).
    pub mixed: bool,
}

impl Default for Format {
    /// Archivo nuevo, o sin ningún salto de línea: LF y sin BOM.
    fn default() -> Self {
        Format { eol: Eol::Lf, bom: false, mixed: false }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileRead {
    /// Normalizado a `\n`.
    pub text: String,
    pub eol: Eol,
    pub bom: bool,
    pub mixed: bool,
    /// md5 del contenido completo (BOM incluido). Se compara exacto: mtime y tamaño no alcanzan.
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteOutcome {
    pub written: bool,
    pub version: String,
}

pub fn version_of(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}

// --- rutas -------------------------------------------------------------------------------------------------------

const RESERVADOS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn es_reservado(componente: &str) -> bool {
    // En Windows `CON.tex` es el dispositivo CON igual que `CON`.
    let base = componente.split('.').next().unwrap_or("");
    RESERVADOS.iter().any(|r| base.eq_ignore_ascii_case(r))
}

/// Convierte una ruta del protocolo (relativa a la raíz, con `/`) en una ruta de disco, o la rechaza.
/// `permitir_raiz`: la cadena vacía significa la raíz misma (sólo para listar carpetas).
pub fn resolver(root: &Path, rel: &str, permitir_raiz: bool) -> Result<PathBuf> {
    let mal = |m: &str| Error::InvalidPath(format!("{rel:?}: {m}"));
    if rel.is_empty() {
        return if permitir_raiz { Ok(root.to_path_buf()) } else { Err(mal("vacía")) };
    }
    // `:` cubre `C:foo`, `C:\x` y los flujos alternativos (`a.tex:x`); `\` y `/` inicial, las absolutas y las UNC.
    if rel.contains('\0') || rel.contains('\\') || rel.contains(':') || rel.starts_with('/') {
        return Err(mal("tiene que ser relativa a la raíz del proyecto y separar con /"));
    }
    let mut destino = root.to_path_buf();
    for comp in rel.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            return Err(mal("componente vacío, `.` o `..`"));
        }
        if es_reservado(comp) {
            return Err(mal("nombre reservado de Windows"));
        }
        if comp.ends_with('.') || comp.ends_with(' ') {
            return Err(mal("Windows ignora el punto o el espacio final"));
        }
        destino.push(comp);
    }
    // Una junction o un enlace simbólico adentro del proyecto puede apuntar afuera: se compara contra la ruta real.
    let raiz_real = dunce::canonicalize(root).map_err(|e| Error::Io(format!("{}: {e}", root.display())))?;
    let real = if destino.exists() {
        dunce::canonicalize(&destino).map_err(|e| Error::Io(format!("{}: {e}", destino.display())))?
    } else {
        let padre = destino.parent().ok_or_else(|| mal("sin carpeta"))?;
        dunce::canonicalize(padre).map_err(|_| Error::NotFound(format!("la carpeta de {rel:?} no existe")))?
    };
    if !real.starts_with(&raiz_real) {
        return Err(mal("sale de la raíz del proyecto"));
    }
    Ok(destino)
}

// --- decodificación ------------------------------------------------------------------------------------------------

fn detectar_eol(b: &[u8]) -> (Eol, bool) {
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' if i + 1 < b.len() && b[i + 1] == b'\n' => {
                crlf += 1;
                i += 2;
                continue;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    let tipos = [crlf, lf, cr].iter().filter(|&&n| n > 0).count();
    let eol = if tipos == 0 {
        Eol::Lf
    } else if crlf >= lf && crlf >= cr {
        Eol::Crlf
    } else if lf >= cr {
        Eol::Lf
    } else {
        Eol::Cr
    };
    (eol, tipos > 1)
}

/// Bytes de disco -> texto normalizado y formato. Rechaza lo que no sea UTF-8.
pub fn decodificar(bytes: &[u8]) -> Result<(String, Format)> {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(Error::NotText("está en UTF-16".into()));
    }
    if bytes.contains(&0) {
        return Err(Error::NotText("tiene bytes nulos (¿es binario?)".into()));
    }
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let cuerpo = if bom { &bytes[3..] } else { bytes };
    let texto = std::str::from_utf8(cuerpo).map_err(|e| Error::NotText(format!("UTF-8 inválido en el byte {}", e.valid_up_to())))?;
    let (eol, mixed) = detectar_eol(cuerpo);
    let normalizado = texto.replace("\r\n", "\n").replace('\r', "\n");
    Ok((normalizado, Format { eol, bom, mixed }))
}

/// Texto normalizado -> bytes de disco con el formato dado.
pub fn codificar(text: &str, f: Format) -> Result<Vec<u8>> {
    if text.contains('\r') {
        return Err(Error::InvalidText("trae `\\r`: el texto llega normalizado a `\\n`".into()));
    }
    let mut out = Vec::with_capacity(text.len() + 16);
    if f.bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    if f.eol == Eol::Lf {
        out.extend_from_slice(text.as_bytes());
    } else {
        out.extend_from_slice(text.replace('\n', f.eol.as_str()).as_bytes());
    }
    Ok(out)
}

// --- lectura y escritura -----------------------------------------------------------------------------------------------

pub fn read_file(root: &Path, rel: &str) -> Result<FileRead> {
    let path = resolver(root, rel, false)?;
    let bytes = fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(rel.to_string()),
        _ => Error::Io(format!("{rel}: {e}")),
    })?;
    let (text, f) = decodificar(&bytes)?;
    Ok(FileRead { text, eol: f.eol, bom: f.bom, mixed: f.mixed, version: version_of(&bytes) })
}

static TEMPORAL: AtomicU64 = AtomicU64::new(0);

/// `expected_version`: la versión que devolvió `read_file` (o la última `write_file`). Si el disco ya tiene otra,
/// `Conflict`: alguien más tocó el archivo. `None` sólo es válido para un archivo que todavía no existe.
pub fn write_file(root: &Path, rel: &str, text: &str, expected_version: Option<&str>) -> Result<WriteOutcome> {
    let path = resolver(root, rel, false)?;
    let existente = match fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(Error::Io(format!("{rel}: {e}"))),
    };
    let formato = match &existente {
        Some(b) => {
            let disco = version_of(b);
            // Sin versión esperada tampoco se pisa un archivo que ya existe: no se sabe qué se está pisando.
            if expected_version != Some(disco.as_str()) {
                return Err(Error::Conflict { disk_version: disco });
            }
            decodificar(b)?.1
        }
        None => {
            if expected_version.is_some() {
                return Err(Error::Conflict { disk_version: String::new() });
            }
            Format::default()
        }
    };
    let nuevos = codificar(text, formato)?;
    if existente.as_deref() == Some(nuevos.as_slice()) {
        return Ok(WriteOutcome { written: false, version: version_of(&nuevos) });
    }
    if existente.is_some() && fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err(Error::Io(format!("{rel}: el archivo es de sólo lectura")));
    }
    escribir_atomico(&path, &nuevos).map_err(|e| Error::Io(format!("{rel}: {e}")))?;
    Ok(WriteOutcome { written: true, version: version_of(&nuevos) })
}

/// Archivo temporal en la misma carpeta y rename sobre el destino: un corte a mitad de escritura no deja un `.tex`
/// truncado. En Windows el rename falla mientras alguien tiene el destino abierto sin compartir borrado (pdflatex
/// leyendo un `\input`, el antivirus, OneDrive), y guardar durante un build de 6 minutos es el caso normal: se
/// reintenta con espera creciente antes de rendirse.
pub(crate) fn escribir_atomico(destino: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let n = TEMPORAL.fetch_add(1, Ordering::Relaxed);
    let temporal = destino.with_file_name(format!(".lvtmp-{}-{n}.tmp", std::process::id()));
    let limpiar = |t: &Path| {
        let _ = fs::remove_file(t);
    };
    let escritura = (|| {
        let mut f = fs::File::create(&temporal)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = escritura {
        limpiar(&temporal);
        return Err(e);
    }
    let mut espera = Duration::from_millis(20);
    let mut ultimo = None;
    for _ in 0..10 {
        match fs::rename(&temporal, destino) {
            Ok(()) => return Ok(()),
            Err(e) => {
                // 5 = acceso denegado, 32 = violación de uso compartido, 33 = violación de bloqueo.
                let transitorio = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33));
                ultimo = Some(e);
                if !transitorio {
                    break;
                }
                std::thread::sleep(espera);
                espera = (espera * 2).min(Duration::from_millis(400));
            }
        }
    }
    limpiar(&temporal);
    Err(ultimo.unwrap_or_else(|| std::io::Error::other("rename falló")))
}
