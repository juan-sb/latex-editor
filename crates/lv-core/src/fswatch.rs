//! Archivos cambiados afuera de la app (`fs:changed`, 10.1 del plan): un observador (`notify`) sobre el árbol del proyecto que junta
//! los eventos en ráfagas y avisa qué archivos cambiaron. Para el libro importa: los scripts de `Herramientas/` reescriben
//! `Secciones/fig_*.tex` mientras la app está abierta.
//!
//! **Tiene que ignorar todo lo que escribe la propia compilación**, o cada build dispararía otro: `.lv/` (drivers, builds, estado), el
//! cache de figuras, los auxiliares de TeX (`.aux`, `.log`, `.toc`, `.fdb_latexmk`, `.bbl`, `.synctex.gz`...), el `.run.xml` de biblatex
//! que queda en la raíz, los `.md5` y `.dpth` de pgf, la carpeta de exportación y la de publicación si están dentro del proyecto, y los
//! temporales de la escritura atómica de la app. Lo que queda son los archivos del usuario (fuentes, imágenes, `.bib`, los `.tex` que
//! genera un script).

use crate::error::{Error, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Decide por la ruta relativa (con `/`) si un cambio no cuenta.
pub type Ignorar = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// Recibe los archivos que cambiaron en una ráfaga (rutas relativas con `/`, sin repetir y en orden).
pub type Aviso = Arc<dyn Fn(Vec<String>) + Send + Sync>;

/// Extensiones que escribe TeX (o pgf, o biblatex) al compilar: nunca son del usuario.
const EXTENSIONES_DE_BUILD: [&str; 22] = [
    "aux", "log", "toc", "lof", "lot", "out", "bbl", "bcf", "blg", "idx", "ind", "ilg", "fdb_latexmk", "fls", "auxlock", "xdv", "nav", "snm", "vrb",
    "md5", "dpth", "figlist",
];

/// Lo que una compilación deja en el proyecto, por el nombre del archivo.
pub fn es_residuo_de_build(rel: &str) -> bool {
    let nombre = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    if nombre.ends_with(".run.xml") || nombre.ends_with(".synctex.gz") || nombre.ends_with(".synctex") || nombre.ends_with(".makefile") {
        return true;
    }
    // Los temporales de la escritura atómica de la app y los de los editores.
    if nombre.starts_with(".lvtmp-") || nombre.ends_with(".tmp") || nombre.ends_with('~') || nombre.ends_with(".swp") || nombre.starts_with(".#") {
        return true;
    }
    nombre.rsplit_once('.').is_some_and(|(_, ext)| EXTENSIONES_DE_BUILD.contains(&ext))
}

/// ¿`rel` está adentro de alguna de estas carpetas (relativas, con `/`)?
pub fn esta_en(rel: &str, carpetas: &[String]) -> bool {
    carpetas.iter().any(|c| {
        let c = c.trim_matches('/');
        !c.is_empty() && (rel == c || rel.strip_prefix(c).is_some_and(|r| r.starts_with('/')))
    })
}

/// Lo que se ignora siempre, además de lo que pide cada proyecto (`carpetas`: el cache de figuras, la exportación, la publicación).
pub fn ignorar_de_proyecto(rel: &str, carpetas: &[String]) -> bool {
    rel == ".lv" || rel.starts_with(".lv/") || rel == ".git" || rel.starts_with(".git/") || esta_en(rel, carpetas) || es_residuo_de_build(rel)
}

/// El observador vive mientras viva este valor: al soltarlo se deja de observar.
pub struct Observador {
    _watcher: notify::RecommendedWatcher,
}

/// Empieza a observar `root`. Los cambios se juntan hasta que pasan `silencio` sin eventos (o 2 s desde el primero) y salen todos
/// juntos: un script que reescribe tres archivos es un solo aviso.
pub fn observar(root: &Path, ignorar: Ignorar, aviso: Aviso, silencio: Duration) -> Result<Observador> {
    let root = dunce::canonicalize(root).map_err(|e| Error::Io(format!("{}: {e}", root.display())))?;
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |e| {
        let _ = tx.send(e);
    })
    .map_err(|e| Error::Other(format!("no se pudo crear el observador de archivos: {e}")))?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| Error::Other(format!("no se pudo observar {}: {e}", root.display())))?;
    std::thread::spawn(move || bucle(&root, rx, ignorar, aviso, silencio));
    Ok(Observador { _watcher: watcher })
}

fn relativa(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok().or_else(|| dunce::simplified(p).strip_prefix(root).ok())?;
    let r = rel.to_string_lossy().replace('\\', "/");
    (!r.is_empty()).then_some(r)
}

fn bucle(root: &Path, rx: mpsc::Receiver<notify::Result<notify::Event>>, ignorar: Ignorar, aviso: Aviso, silencio: Duration) {
    let mut juntos: BTreeSet<String> = BTreeSet::new();
    let mut desde = Instant::now();
    loop {
        let recibido = if juntos.is_empty() {
            match rx.recv() {
                Ok(e) => Some(e),
                Err(_) => return,
            }
        } else {
            match rx.recv_timeout(silencio) {
                Ok(e) => Some(e),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    aviso(std::mem::take(&mut juntos).into_iter().collect());
                    return;
                }
            }
        };
        if let Some(Ok(ev)) = recibido {
            if !matches!(ev.kind, EventKind::Access(_)) {
                for p in &ev.paths {
                    // Windows avisa que la carpeta "cambió" cada vez que cambia un archivo de adentro: la carpeta sola no es un cambio.
                    if matches!(ev.kind, EventKind::Modify(_)) && p.is_dir() {
                        continue;
                    }
                    if let Some(rel) = relativa(root, p) {
                        if !ignorar(&rel) {
                            if juntos.is_empty() {
                                desde = Instant::now();
                            }
                            juntos.insert(rel);
                        }
                    }
                }
            }
            // Una ráfaga que no para (un script largo) no puede dejar la aplicación sin enterarse para siempre.
            if !juntos.is_empty() && desde.elapsed() < Duration::from_secs(2) {
                continue;
            }
        }
        if !juntos.is_empty() {
            aviso(std::mem::take(&mut juntos).into_iter().collect());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn lo_que_escribe_la_compilacion_no_cuenta_y_lo_del_usuario_si() {
        let carpetas = vec!["figuras-cache".to_string(), "../PDF".to_string(), "export".to_string()];
        for ignorado in [
            ".lv/state.json",
            ".lv/build/rapido/lv-rapido.pdf",
            "figuras-cache/A-0.pdf",
            "export/08 - X.pdf",
            "Secciones/Uno.aux",
            "lv-cocina.run.xml",
            "Libro.fdb_latexmk",
            "Libro.synctex.gz",
            "x/.lvtmp-12-3.tmp",
            "a.tex~",
            "figuras-cache/A-0.md5",
            ".git/index",
            "Libro.bbl",
            "nuevo.TOC",
        ] {
            assert!(ignorar_de_proyecto(ignorado, &carpetas), "{ignorado} es de la compilación");
        }
        for del_usuario in ["Secciones/Uno.tex", "Secciones/fig_engranaje_pinon.tex", "img/foto.png", "bibliography.bib", "estilo_figuras.tex", "Herramientas/gen.py", "Herramientas/preview/engranajes.tex", "figuras-cache-no/a.tex", "exports.tex"] {
            assert!(!ignorar_de_proyecto(del_usuario, &carpetas), "{del_usuario} es del usuario");
        }
    }

    fn esperar(rx: &mpsc::Receiver<Vec<String>>, seg: u64) -> Option<Vec<String>> {
        rx.recv_timeout(Duration::from_secs(seg)).ok()
    }

    fn con_observador(d: &Path) -> (Observador, mpsc::Receiver<Vec<String>>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let carpetas = vec!["figuras-cache".to_string()];
        let o = observar(d, Arc::new(move |rel: &str| ignorar_de_proyecto(rel, &carpetas)), Arc::new(move |v| drop(tx.lock().unwrap().send(v))), Duration::from_millis(150)).unwrap();
        // Los observadores arrancan de a poco: que no se pierda lo primero que se escribe.
        std::thread::sleep(Duration::from_millis(300));
        (o, rx)
    }

    #[test]
    fn una_rafaga_de_cambios_sale_en_un_solo_aviso_sin_lo_que_se_ignora() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("Secciones")).unwrap();
        std::fs::create_dir_all(d.path().join(".lv/build")).unwrap();
        std::fs::create_dir_all(d.path().join("figuras-cache")).unwrap();
        let (_o, rx) = con_observador(d.path());
        for i in 0..5 {
            std::fs::write(d.path().join("Secciones/fig_a.tex"), format!("v{i}")).unwrap();
            std::fs::write(d.path().join(".lv/build/x.log"), format!("{i}")).unwrap();
            std::fs::write(d.path().join("figuras-cache/A-0.pdf"), format!("{i}")).unwrap();
            std::fs::write(d.path().join("main.aux"), format!("{i}")).unwrap();
        }
        std::fs::write(d.path().join("Secciones/fig_b.tex"), "b").unwrap();
        let primero = esperar(&rx, 10).expect("un aviso");
        assert_eq!(primero, ["Secciones/fig_a.tex", "Secciones/fig_b.tex"], "sin el log, el cache ni el .aux");
        assert!(esperar(&rx, 1).is_none(), "una sola ráfaga, un solo aviso");
    }

    #[test]
    fn borrar_y_renombrar_tambien_se_avisan() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.tex"), "a").unwrap();
        let (_o, rx) = con_observador(d.path());
        std::fs::rename(d.path().join("a.tex"), d.path().join("b.tex")).unwrap();
        let v = esperar(&rx, 10).expect("aviso del renombre");
        assert!(v.contains(&"a.tex".to_string()) || v.contains(&"b.tex".to_string()), "{v:?}");
        std::fs::remove_file(d.path().join("b.tex")).unwrap();
        let v = esperar(&rx, 10).expect("aviso del borrado");
        assert!(v.contains(&"b.tex".to_string()), "{v:?}");
    }
}
