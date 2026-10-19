//! Cache de figuras de TikZ (sección 7 del plan). Esta primera parte es la **verificación de las figuras que se lanzaron**
//! en un build o en una cocción (revisión previa a F6, hallazgo 1); el sello, el listado, la cocción y la limpieza se suman
//! en los pasos siguientes de F6.
//!
//! El problema: pgf escribe el `.md5` nuevo de una figura *antes* de lanzar su subcompilación (`\tikzexternal@check@uptodate@mode`).
//! Si la subcompilación falla, o el build se cancela mientras corre, queda el `.md5` nuevo junto al PDF viejo (o a uno
//! cortado) y pgf da la figura por al día: el build sale con código 0, sin errores en el log principal y con la imagen
//! anterior (reproducido con MiKTeX en `tests/figuras_rotas.rs` y con TeX Live en la revisión). La app lo empeoraba al mover
//! los `.md5` al cache compartido después de cualquier build.
//!
//! La regla: una figura lanzada pasa si su `.log` no tiene un error fatal y su PDF es posterior al inicio y termina en
//! `%%EOF`. Si no pasa se borran su PDF y su `.md5` (en el cache y en el directorio del perfil), así el build siguiente la
//! reintenta, y su error va al panel de problemas.

use crate::auxiliares::build_dir;
use crate::logparse::{self, Problem, Severity};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Una figura que se lanzó y no salió bien.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiguraRota {
    /// El `-jobname` con el que se lanzó, relativo a la raíz y con `/` (`figuras-cache/A1B2C3-cauer-0`).
    pub nombre: String,
    /// Por qué: los errores de su `.log` con el archivo y la línea de la fuente (vacío si fue una cancelación).
    pub problemas: Vec<Problem>,
}

/// biblatex escribe `<job>.run.xml` en el directorio de trabajo cuando compila una figura: con `\tikzexternalrealjob` definido usa
/// el nombre del job real y no el `\jobname` de la subcompilación (medido en F6 con el libro: `lv-cocina.run.xml` aparecía en la
/// raíz del proyecto al terminar la cocción). Es un residuo sin valor, y deja la raíz sucia; se borra al terminar.
pub fn quitar_residuos_de_subcompilacion(root: &Path, job: &str) {
    if job.is_empty() || job.contains(['/', '\\', ':']) {
        return;
    }
    let _ = fs::remove_file(root.join(format!("{job}.run.xml")));
}

/// El nombre de una figura sin el directorio del cache, para mostrarlo.
pub fn nombre_corto(nombre: &str) -> &str {
    nombre.rsplit('/').next().unwrap_or(nombre)
}

fn ruta(root: &Path, nombre: &str, ext: &str) -> Option<PathBuf> {
    // El nombre sale del stream de latexmk: no se confía en que sea una ruta decente.
    if nombre.is_empty() || nombre.starts_with('/') || nombre.contains("..") || nombre.contains(':') || nombre.contains('\\') {
        return None;
    }
    Some(root.join(format!("{nombre}.{ext}")))
}

fn termina_en_eof(p: &Path) -> bool {
    let Ok(mut f) = fs::File::open(p) else { return false };
    let Ok(largo) = f.seek(SeekFrom::End(0)) else { return false };
    let desde = largo.saturating_sub(1024);
    let mut cola = Vec::new();
    f.seek(SeekFrom::Start(desde)).ok().and_then(|_| f.read_to_end(&mut cola).ok());
    cola.windows(5).any(|w| w == b"%%EOF")
}

fn log_fatal(log: &[u8]) -> bool {
    let t = String::from_utf8_lossy(log);
    t.contains("Fatal error occurred") || t.contains("! Emergency stop")
}

/// ¿Salió bien la figura? Mira el `.log` de su subcompilación y su PDF.
fn salio_bien(root: &Path, nombre: &str, desde: SystemTime) -> bool {
    let (Some(pdf), Some(log)) = (ruta(root, nombre, "pdf"), ruta(root, nombre, "log")) else { return false };
    let Ok(bytes) = fs::read(&log) else { return false };
    if log_fatal(&bytes) {
        return false;
    }
    let reciente = fs::metadata(&pdf).and_then(|m| m.modified()).is_ok_and(|m| m >= desde);
    reciente && termina_en_eof(&pdf)
}

/// Borra lo que haría que pgf (o la cocción) dé la figura por buena: el PDF, el `.dpth` y los `.md5`.
fn desacreditar(root: &Path, perfil: &str, nombre: &str) {
    for ext in ["pdf", "dpth"] {
        if let Some(p) = ruta(root, nombre, ext) {
            let _ = fs::remove_file(p);
        }
    }
    if let Some(p) = ruta(root, nombre, "md5") {
        let _ = fs::remove_file(p);
    }
    let _ = fs::remove_file(build_dir(root, perfil).join(format!("{nombre}.md5")));
}

/// El ancho al que TeX corta las líneas de su log cuando nadie le pide otro. La subcompilación de una figura la lanza pgf
/// con su propia línea de comandos, sin `-max-print-line`, y MiKTeX ignora la variable de entorno `max_print_line`: el log
/// de la figura llega cortado a 79 columnas y una ruta o un nombre de archivo partido rompe la pila de archivos del parser.
const ANCHO_DEL_LOG: usize = 79;

/// Une las líneas que TeX cortó al llegar al ancho máximo. Una línea de exactamente 79 caracteres seguida de otra se toma
/// como una sola: una línea genuina de ese largo exacto es rara, y el costo de confundirla es un nombre de archivo más largo.
fn desenvolver(log: &[u8]) -> Vec<u8> {
    let texto = String::from_utf8_lossy(log);
    let mut salida = String::with_capacity(texto.len());
    let mut lineas = texto.split('\n').peekable();
    while let Some(l) = lineas.next() {
        let limpia = l.trim_end_matches('\r');
        salida.push_str(limpia);
        if limpia.chars().count() == ANCHO_DEL_LOG && lineas.peek().is_some_and(|n| !n.is_empty()) {
            continue;
        }
        if lineas.peek().is_some() {
            salida.push('\n');
        }
    }
    salida.into_bytes()
}

/// Los errores del `.log` de la figura, como problemas de la interfaz: `kind = "figure"`, con el archivo y la línea de la
/// fuente que dice el log de la subcompilación. Sin errores legibles, uno genérico que apunta al `.log`.
fn problemas_de(root: &Path, nombre: &str) -> Vec<Problem> {
    let corto = nombre_corto(nombre);
    let bytes = ruta(root, nombre, "log").and_then(|p| fs::read(p).ok()).unwrap_or_default();
    let mut v: Vec<Problem> = logparse::parse_tex_log(&desenvolver(&bytes), root)
        .into_iter()
        .filter(|p| p.severity == Severity::Error)
        .map(|p| Problem { kind: "figure".into(), message: format!("Figura «{corto}»: {}", p.message), ..p })
        .collect();
    if v.is_empty() {
        v.push(Problem {
            severity: Severity::Error,
            kind: "figure".into(),
            message: format!("La figura «{corto}» no se generó: revisá {nombre}.log"),
            file: Some(format!("{nombre}.log")),
            line: None,
            line_end: None,
            context: String::new(),
        });
    }
    v
}

/// Verifica las figuras que se lanzaron desde `desde` (el inicio del build o de la cocción). Las que no pasan quedan
/// desacreditadas. Con `cancelado` (el trabajo se mató a mitad de camino) las figuras cortadas se borran igual pero no se
/// informan como errores: no hay nada roto en el proyecto, sólo faltó terminar.
pub fn verificar(root: &Path, perfil: &str, nombres: &[String], desde: SystemTime, cancelado: bool) -> Vec<FiguraRota> {
    let mut rotas = Vec::new();
    for nombre in nombres {
        if salio_bien(root, nombre, desde) {
            continue;
        }
        let problemas = if cancelado { vec![] } else { problemas_de(root, nombre) };
        desacreditar(root, perfil, nombre);
        rotas.push(FiguraRota { nombre: nombre.clone(), problemas });
    }
    if !rotas.is_empty() {
        // Sin esto el build siguiente no hace nada: latexmk sólo mira sus fuentes, no sabe que borramos el PDF y el `.md5` de
        // una figura (medido: "Nothing to do ... up-to-date" y la figura nunca se reintentaba). Sin su `.fdb_latexmk` vuelve a
        // correr pdflatex, y pgf, que ya no encuentra el `.md5`, relanza la subcompilación.
        let _ = fs::remove_file(build_dir(root, perfil).join(format!("lv-{perfil}.fdb_latexmk")));
    }
    rotas
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn escribir(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    const PDF_BUENO: &[u8] = b"%PDF-1.5\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";
    const LOG_BUENO: &[u8] = b"This is pdfTeX\nOutput written on figuras-cache/A-uno-0.pdf (1 page, 1234 bytes).\n";
    /// Como sale de verdad: entre `<recently read>` y `l.31` TeX imprime una línea de sólo espacios.
    const LOG_ROTO: &[u8] = b"This is pdfTeX, Version 3.141592653\n(./main.tex\n! Undefined control sequence.\n<recently read> \\comandoQueNoExiste \n                                    \nl.31     \\comandoQueNoExiste\n                            \nThe control sequence at the end of the top line\nof your error message was never \\def'ed.\n\n! ==> Fatal error occurred, no output PDF file produced!\n";

    fn antes() -> SystemTime {
        SystemTime::now() - Duration::from_secs(60)
    }

    fn figura(root: &Path, nombre: &str, pdf: Option<&[u8]>, log: Option<&[u8]>) {
        if let Some(p) = pdf {
            escribir(root, &format!("{nombre}.pdf"), p);
        }
        if let Some(l) = log {
            escribir(root, &format!("{nombre}.log"), l);
        }
        escribir(root, &format!("{nombre}.md5"), b"md5");
        escribir(root, &format!(".lv/build/rapido/{nombre}.md5"), b"md5");
    }

    #[test]
    fn una_figura_con_log_limpio_y_pdf_completo_pasa() {
        let d = tempfile::tempdir().unwrap();
        figura(d.path(), "figuras-cache/A-uno-0", Some(PDF_BUENO), Some(LOG_BUENO));
        assert!(verificar(d.path(), "rapido", &["figuras-cache/A-uno-0".into()], antes(), false).is_empty());
        assert!(d.path().join("figuras-cache/A-uno-0.pdf").is_file() && d.path().join("figuras-cache/A-uno-0.md5").is_file());
    }

    #[test]
    fn un_error_fatal_en_su_log_la_desacredita_aunque_haya_un_pdf_viejo_y_se_informa_con_su_linea() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        figura(r, "figuras-cache/A-uno-0", Some(PDF_BUENO), Some(LOG_ROTO));
        escribir(r, "main.tex", b"\\documentclass{article}\n");
        escribir(r, ".lv/build/rapido/lv-rapido.fdb_latexmk", b"fdb");
        let rotas = verificar(r, "rapido", &["figuras-cache/A-uno-0".into()], antes(), false);
        assert_eq!(rotas.len(), 1);
        assert!(!r.join(".lv/build/rapido/lv-rapido.fdb_latexmk").exists(), "sin su fdb latexmk vuelve a correr y la figura se reintenta");
        let p = &rotas[0].problemas;
        assert_eq!(p.len(), 1, "{p:#?}");
        assert_eq!(p[0].kind, "figure");
        assert!(p[0].message.starts_with("Figura «A-uno-0»: Undefined control sequence"), "{}", p[0].message);
        assert_eq!((p[0].file.as_deref(), p[0].line), (Some("main.tex"), Some(31)));
        for rel in ["figuras-cache/A-uno-0.pdf", "figuras-cache/A-uno-0.md5", ".lv/build/rapido/figuras-cache/A-uno-0.md5"] {
            assert!(!r.join(rel).exists(), "{rel} se borra");
        }
        assert!(r.join("figuras-cache/A-uno-0.log").is_file(), "el .log queda: es la prueba del error");
    }

    #[test]
    fn sin_pdf_o_con_el_pdf_de_antes_del_build_o_cortado_no_pasa() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        figura(r, "figuras-cache/sin-pdf", None, Some(LOG_BUENO));
        figura(r, "figuras-cache/cortado", Some(b"%PDF-1.5\n1 0 obj\n<<>>\nendo"), Some(LOG_BUENO));
        figura(r, "figuras-cache/viejo", Some(PDF_BUENO), Some(LOG_BUENO));
        figura(r, "figuras-cache/sin-log", Some(PDF_BUENO), None);
        // "viejo" es de antes del inicio del build: no lo escribió este build.
        let despues = SystemTime::now() + Duration::from_secs(3600);
        let nombres: Vec<String> = ["sin-pdf", "cortado", "viejo", "sin-log"].iter().map(|n| format!("figuras-cache/{n}")).collect();
        let rotas = verificar(r, "rapido", &nombres, despues, false);
        assert_eq!(rotas.len(), 4);
        assert!(rotas.iter().all(|f| f.problemas.len() == 1 && f.problemas[0].kind == "figure"), "{rotas:#?}");
        assert!(rotas[0].problemas[0].message.contains("no se generó"), "sin errores legibles, uno genérico que apunta al log");
        // Con un inicio anterior, las que tienen PDF completo y log limpio pasan.
        figura(r, "figuras-cache/viejo", Some(PDF_BUENO), Some(LOG_BUENO));
        assert!(verificar(r, "rapido", &["figuras-cache/viejo".into()], antes(), false).is_empty());
    }

    #[test]
    fn al_cancelar_las_cortadas_se_borran_pero_no_se_informan() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        figura(r, "figuras-cache/A-uno-0", Some(b"%PDF-1.5\ncortado"), Some(b"This is pdfTeX\n"));
        let rotas = verificar(r, "rapido", &["figuras-cache/A-uno-0".into()], antes(), true);
        assert_eq!(rotas.len(), 1);
        assert!(rotas[0].problemas.is_empty(), "una figura cortada por cancelar no es un error del proyecto");
        assert!(!r.join("figuras-cache/A-uno-0.pdf").exists() && !r.join("figuras-cache/A-uno-0.md5").exists());
    }

    #[test]
    fn un_nombre_raro_no_toca_nada_fuera_de_la_raiz() {
        let d = tempfile::tempdir().unwrap();
        let fuera = d.path().join("fuera.pdf");
        fs::write(&fuera, PDF_BUENO).unwrap();
        let raiz = d.path().join("raiz");
        fs::create_dir_all(&raiz).unwrap();
        let rotas = verificar(&raiz, "rapido", &["../fuera".into(), "C:/x".into(), "".into()], antes(), false);
        assert_eq!(rotas.len(), 3, "se consideran rotas, sin tocar el disco");
        assert!(fuera.is_file(), "no se borra nada de afuera");
    }

    #[test]
    fn las_lineas_cortadas_a_79_columnas_se_unen() {
        let a = "x".repeat(79);
        let log = format!("{a}\nresto de la linea\notra\r\n{a}\n");
        assert_eq!(String::from_utf8(desenvolver(log.as_bytes())).unwrap(), format!("{a}resto de la linea\notra\n{a}\n"));
        assert_eq!(String::from_utf8(desenvolver(b"corta\nlinea")).unwrap(), "corta\nlinea");
    }

    #[test]
    fn el_residuo_de_biblatex_se_borra_de_la_raiz_y_nada_mas() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), "lv-cocina.run.xml", b"x");
        escribir(d.path(), "otro.run.xml", b"x");
        escribir(d.path(), "figuras-cache/lv-cocina.run.xml", b"x");
        quitar_residuos_de_subcompilacion(d.path(), "lv-cocina");
        assert!(!d.path().join("lv-cocina.run.xml").exists());
        assert!(d.path().join("otro.run.xml").exists() && d.path().join("figuras-cache/lv-cocina.run.xml").exists());
        quitar_residuos_de_subcompilacion(d.path(), "../lv-cocina");
        quitar_residuos_de_subcompilacion(d.path(), "");
    }

    #[test]
    fn el_nombre_corto_es_lo_que_sigue_a_la_ultima_barra() {
        assert_eq!(nombre_corto("figuras-cache/A1B2C3-cauer-7"), "A1B2C3-cauer-7");
        assert_eq!(nombre_corto("suelto"), "suelto");
    }
}
