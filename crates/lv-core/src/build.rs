//! Compilación con latexmk: driver y `.lv/latexmkrc` generados, proceso con salida en streaming y cancelación.
//!
//! Esquema de S1 (opción A): el perfil compila `.lv/drivers/lv-<perfil>.tex` con cwd = raíz del proyecto, y su PDF y
//! sus auxiliares quedan en `.lv/build/<perfil>/`. El rc de la app se lee después del `latexmkrc` del proyecto.
//!
//! Detalles que no son obvios:
//! - Los eventos de log llevan **fragmentos de texto**, no líneas: pdflatex escribe `[12] [13] [14]...` sin saltos de
//!   línea durante mucho tiempo y, si sólo se emitieran líneas completas, el panel se vería congelado.
//! - stdout y stderr se leen en hilos separados y por bloques de bytes (no con `lines()`): un byte que no es UTF-8
//!   cortaría la lectura, el pipe se llenaría y latexmk quedaría colgado.
//! - `-max-print-line` va por `-latexoption=`: redefinir `$pdflatex` pisaría los envoltorios del `latexmkrc` del
//!   proyecto (el libro mide cada pasada con `pdflatex_registrado`).
//! - `ok` es "código 0 y existe el PDF". `updated` dice si ese build lo reescribió: un build sin cambios sale con 0
//!   sin tocar el PDF y no es un error.

use crate::error::{Error, Result};
use crate::fsio;
use serde::Serialize;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// Sin esto cada pdflatex, biber y makeindex abre una ventana de consola.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BuildEvent {
    Started { id: u64, perfil: String, cmdline: String },
    Log { id: u64, text: String },
    Finished { id: u64, ok: bool, code: Option<i32>, cancelled: bool, ms: u64, pdf: Option<String>, updated: bool },
}

pub type Sink = Arc<dyn Fn(BuildEvent) + Send + Sync>;

// --- archivos generados --------------------------------------------------------------------------------------------

/// Caracteres que rompen `\input{"..."}`: se rechazan en lugar de intentar escaparlos.
const PROHIBIDOS_EN_LA_RAIZ: &str = "#%{}\\\"~^$";

fn perfil_valido(p: &str) -> Result<()> {
    if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::Other(format!("nombre de perfil inválido: {p:?} (ASCII, sin espacios)")));
    }
    Ok(())
}

pub fn driver_rel(perfil: &str) -> String {
    format!(".lv/drivers/lv-{perfil}.tex")
}

pub fn pdf_rel(perfil: &str) -> String {
    format!(".lv/build/{perfil}/lv-{perfil}.pdf")
}

/// Driver ASCII del perfil: define `\lvPerfil` y `\lvParcial` y carga la raíz real del proyecto (4.2 del plan). El
/// nombre del driver es el `\jobname`, así que va sin espacios ni tildes aunque la raíz los tenga (S4).
pub fn render_driver(perfil: &str, root_rel: &str) -> Result<String> {
    perfil_valido(perfil)?;
    if let Some(c) = root_rel.chars().find(|c| PROHIBIDOS_EN_LA_RAIZ.contains(*c)) {
        return Err(Error::InvalidPath(format!("{root_rel:?}: el carácter {c:?} rompe \\input")));
    }
    let base = root_rel.strip_suffix(".tex").or_else(|| root_rel.strip_suffix(".TEX")).unwrap_or(root_rel);
    Ok(format!(
        "% {} (generado por LaTeX Viewer, no editar)\n\\def\\lvPerfil{{{perfil}}}\n\\def\\lvParcial{{0}}\n\\input{{\"{base}\"}}\n",
        driver_rel(perfil)
    ))
}

/// `.lv/latexmkrc`: auxiliares y PDF por perfil (S1, opción A). Se lee después del del proyecto, que en el libro
/// pone `$out_dir = '../PDF'`. Con el perfil en `LV_PERFIL` un solo rc sirve para todos.
///
/// Dos variables de entorno, las dos por lo mismo (cada una la descubrió una prueba distinta):
/// - `TEXINPUTS` con `.lv/drivers`: la subcompilación de pgf hace `\input{<driver>}` desde la raíz y sin esto no lo
///   encuentra (S1).
/// - `INDEXSTYLE` con la raíz: **latexmk corre makeindex desde el directorio de salida**, con nombres sueltos
///   (`makeindex -s StyleInd.ist -o "lv-completo.ind" "lv-completo.idx"`). El `$makeindex` del libro nombra su estilo
///   relativo a la raíz, y sin esto falla con "Index style file StyleInd.ist not found" y el build sale con 12
///   (F1, paso 0: es el perfil que S1 no había probado, porque ni el parcial ni el rápido llevan índice).
pub fn render_latexmkrc() -> String {
    [
        "# LaTeX Viewer: auxiliares y PDF por perfil. Se lee DESPUÉS del latexmkrc del proyecto.",
        "use Cwd;",
        "my $p = $ENV{LV_PERFIL} or die 'falta LV_PERFIL';",
        "my $sep = ($^O eq 'MSWin32') ? ';' : ':';",
        "$out_dir = \".lv/build/$p\";",
        "$aux_dir = \".lv/build/$p\";",
        "$emulate_aux = 0;",
        "$ENV{TEXINPUTS} = \".lv/drivers$sep\" . ($ENV{TEXINPUTS} // '');",
        "$ENV{INDEXSTYLE} = getcwd() . ($ENV{INDEXSTYLE} ? $sep . $ENV{INDEXSTYLE} : '');",
        "",
    ]
    .join("\n")
}

/// Escribe sólo si cambió: tocar el mtime de un archivo que latexmk lee lo hace recompilar.
pub fn write_if_changed(path: &Path, text: &str) -> Result<bool> {
    if std::fs::read(path).is_ok_and(|b| b == text.as_bytes()) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::Io(format!("{}: {e}", dir.display())))?;
    }
    std::fs::write(path, text).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
    Ok(true)
}

pub fn latexmk_args(perfil: &str) -> Vec<String> {
    [
        "-pdf",
        "-synctex=1",
        "-interaction=nonstopmode",
        "-file-line-error",
        "-latexoption=-max-print-line=10000",
        "-r",
        ".lv/latexmkrc",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([driver_rel(perfil)])
    .collect()
}

// --- salida en streaming --------------------------------------------------------------------------------------------

/// Decodifica UTF-8 por bloques sin partir un carácter: lo que quede incompleto al final del bloque espera al
/// siguiente. Los bytes inválidos se reemplazan por U+FFFD, como `from_utf8_lossy`.
#[derive(Default)]
pub(crate) struct Utf8Chunker {
    pendiente: Vec<u8>,
}

impl Utf8Chunker {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.pendiente.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pendiente) {
                Ok(s) => {
                    out.push_str(s);
                    self.pendiente.clear();
                    return out;
                }
                Err(e) => {
                    let v = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pendiente[..v]).unwrap_or(""));
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            self.pendiente.drain(..v + n);
                        }
                        None => {
                            // Secuencia cortada al final del bloque: se espera el resto.
                            self.pendiente.drain(..v);
                            return out;
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.pendiente.is_empty() {
            String::new()
        } else {
            self.pendiente.clear();
            "\u{FFFD}".into()
        }
    }
}

fn leer_flujo<R: Read>(mut r: R, tx: mpsc::Sender<String>) {
    let mut chunker = Utf8Chunker::default();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let s = chunker.push(&buf[..n]);
                if !s.is_empty() && tx.send(s).is_err() {
                    return;
                }
            }
        }
    }
    let resto = chunker.finish();
    if !resto.is_empty() {
        let _ = tx.send(resto);
    }
}

// --- el builder ------------------------------------------------------------------------------------------------------

struct Activo {
    pid: u32,
    cancelado: Arc<AtomicBool>,
}

pub struct Builder {
    estado: Arc<Mutex<Option<Activo>>>,
    siguiente: AtomicU64,
    programa: OsString,
    /// Argumentos que van antes de los de latexmk: sólo los usan los tests, para correr un script en su lugar.
    pre_args: Vec<OsString>,
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        let programa = std::env::var_os("LV_LATEXMK").unwrap_or_else(|| "latexmk".into());
        Self::con_programa(programa, vec![])
    }

    pub fn con_programa(programa: impl Into<OsString>, pre_args: Vec<OsString>) -> Self {
        Builder { estado: Arc::new(Mutex::new(None)), siguiente: AtomicU64::new(1), programa: programa.into(), pre_args }
    }

    pub fn is_running(&self) -> bool {
        self.estado.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Lanza el build y devuelve su id enseguida; los eventos llegan por `sink` desde otro hilo. Los errores que se
    /// pueden saber antes de lanzar (ocupado, ruta inválida, sin latexmk) vuelven acá.
    pub fn start(&self, root: &Path, root_rel: &str, perfil: &str, sink: Sink) -> Result<u64> {
        let mut guardia = self.estado.lock().map_err(|_| Error::Other("estado del build envenenado".into()))?;
        if guardia.is_some() {
            return Err(Error::Busy);
        }
        let raiz = fsio::resolver(root, root_rel, false)?;
        if !raiz.is_file() {
            return Err(Error::NotFound(root_rel.to_string()));
        }
        let driver = render_driver(perfil, root_rel)?;
        write_if_changed(&root.join(driver_rel(perfil)), &driver)?;
        write_if_changed(&root.join(".lv").join("latexmkrc"), &render_latexmkrc())?;

        let args = latexmk_args(perfil);
        let mut cmd = Command::new(&self.programa);
        cmd.args(&self.pre_args)
            .args(&args)
            .current_dir(root)
            .env("LV_PERFIL", perfil)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let inicio_sistema = SystemTime::now();
        let inicio = Instant::now();
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                Error::NoLatexmk(format!("{}: no está en el PATH (¿está instalado MiKTeX o TeX Live?)", self.programa.to_string_lossy()))
            }
            _ => Error::NoLatexmk(e.to_string()),
        })?;

        let id = self.siguiente.fetch_add(1, Ordering::Relaxed);
        let cancelado = Arc::new(AtomicBool::new(false));
        *guardia = Some(Activo { pid: child.id(), cancelado: cancelado.clone() });
        drop(guardia);

        let (tx, rx) = mpsc::channel::<String>();
        let lectores: Vec<_> = [
            child.stdout.take().map(|o| (Box::new(o) as Box<dyn Read + Send>, tx.clone())),
            child.stderr.take().map(|e| (Box::new(e) as Box<dyn Read + Send>, tx.clone())),
        ]
        .into_iter()
        .flatten()
        .map(|(r, t)| std::thread::spawn(move || leer_flujo(r, t)))
        .collect();
        drop(tx); // sin esto el canal nunca se desconecta

        let estado = self.estado.clone();
        let cmdline = format!(
            "{} {}",
            self.programa.to_string_lossy(),
            self.pre_args.iter().map(|a| a.to_string_lossy().to_string()).chain(args).collect::<Vec<_>>().join(" ")
        );
        let perfil = perfil.to_string();
        let pdf_ruta = root.join(pdf_rel(&perfil));
        let pdf_relativo = pdf_rel(&perfil);

        std::thread::spawn(move || {
            sink(BuildEvent::Started { id, perfil: perfil.clone(), cmdline });
            let mut buf = String::new();
            let mut ultimo = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(s) => buf.push_str(&s),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if !buf.is_empty() && (ultimo.elapsed() >= Duration::from_millis(50) || buf.len() >= 64 * 1024) {
                    sink(BuildEvent::Log { id, text: std::mem::take(&mut buf) });
                    ultimo = Instant::now();
                }
            }
            if !buf.is_empty() {
                sink(BuildEvent::Log { id, text: std::mem::take(&mut buf) });
            }
            for l in lectores {
                let _ = l.join();
            }
            let status = child.wait();
            let code = status.as_ref().ok().and_then(|s| s.code());
            let fue_cancelado = cancelado.load(Ordering::SeqCst);
            let existe = pdf_ruta.is_file();
            let updated = std::fs::metadata(&pdf_ruta).and_then(|m| m.modified()).is_ok_and(|m| m >= inicio_sistema);
            let ok = !fue_cancelado && code == Some(0) && existe;
            // Se libera antes de avisar: quien reciba `Finished` puede lanzar otro build enseguida.
            if let Ok(mut g) = estado.lock() {
                *g = None;
            }
            // Mismo hilo que los `Log`: el final nunca llega antes que las últimas líneas.
            sink(BuildEvent::Finished {
                id,
                ok,
                code,
                cancelled: fue_cancelado,
                ms: inicio.elapsed().as_millis() as u64,
                pdf: existe.then_some(pdf_relativo),
                updated,
            });
        });
        Ok(id)
    }

    /// Cancela el build en curso matando todo el árbol (latexmk lanza perl, pdflatex, biber...). Devuelve si había uno.
    /// Los Job Objects de Windows son de F2/F8: `taskkill /T` alcanza para F1.
    pub fn cancel(&self) -> bool {
        let Ok(g) = self.estado.lock() else { return false };
        let Some(a) = g.as_ref() else { return false };
        a.cancelado.store(true, Ordering::SeqCst);
        matar_arbol(a.pid);
        true
    }
}

#[cfg(windows)]
fn matar_arbol(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn matar_arbol(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunker_no_parte_un_caracter_entre_bloques() {
        let bytes = "añb€".as_bytes(); // ñ = 2 bytes, € = 3 bytes
        for corte in 1..bytes.len() {
            let mut c = Utf8Chunker::default();
            let mut s = c.push(&bytes[..corte]);
            s.push_str(&c.push(&bytes[corte..]));
            s.push_str(&c.finish());
            assert_eq!(s, "añb€", "corte en {corte}");
        }
    }

    #[test]
    fn chunker_reemplaza_los_bytes_invalidos_y_sigue() {
        let mut c = Utf8Chunker::default();
        assert_eq!(c.push(b"ab\xFF\xFEcd"), "ab\u{FFFD}\u{FFFD}cd");
        // Una secuencia que queda abierta al terminar la salida se cierra con un reemplazo.
        let mut c = Utf8Chunker::default();
        assert_eq!(c.push(&[b'a', 0xE2, 0x82]), "a");
        assert_eq!(c.finish(), "\u{FFFD}");
    }

    #[test]
    fn el_driver_define_el_perfil_y_carga_la_raiz_con_tildes_y_espacios() {
        let d = render_driver("completo", "Funciones de Aproximación.tex").unwrap();
        assert_eq!(
            d,
            "% .lv/drivers/lv-completo.tex (generado por LaTeX Viewer, no editar)\n\\def\\lvPerfil{completo}\n\\def\\lvParcial{0}\n\\input{\"Funciones de Aproximación\"}\n"
        );
        assert!(!d.contains("CompilacionReducida"));
        assert!(render_driver("completo", "Secciones/x.tex").unwrap().contains("\\input{\"Secciones/x\"}"));
    }

    #[test]
    fn el_driver_rechaza_raices_que_rompen_input_y_perfiles_raros() {
        for malo in ["a#b.tex", "100%.tex", "a{b}.tex", "a\"b.tex", "a~b.tex", "a^b.tex", "a$b.tex"] {
            assert!(matches!(render_driver("completo", malo), Err(Error::InvalidPath(_))), "{malo}");
        }
        for perfil in ["", "con espacio", "tilde-ñ", "a/b"] {
            assert!(render_driver(perfil, "main.tex").is_err(), "{perfil:?}");
        }
    }

    #[test]
    fn el_rc_pone_la_salida_por_perfil_y_texinputs() {
        let rc = render_latexmkrc();
        assert!(rc.contains("$out_dir = \".lv/build/$p\";"));
        assert!(rc.contains("$aux_dir = \".lv/build/$p\";"));
        assert!(rc.contains("TEXINPUTS"));
        // latexmk corre makeindex desde el directorio de salida: el estilo del proyecto se busca en la raíz.
        assert!(rc.contains("$ENV{INDEXSTYLE} = getcwd()"));
        assert!(rc.ends_with('\n') && !rc.contains('\r'));
    }

    #[test]
    fn la_linea_de_comandos_usa_latexoption_y_no_redefine_pdflatex() {
        let a = latexmk_args("completo");
        assert!(a.contains(&"-latexoption=-max-print-line=10000".to_string()));
        assert!(!a.iter().any(|x| x.contains("$pdflatex") || x.starts_with("-pdflatex")));
        assert_eq!(a.last().unwrap(), ".lv/drivers/lv-completo.tex");
    }
}
