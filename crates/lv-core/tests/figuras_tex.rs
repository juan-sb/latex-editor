//! El cache de figuras con TeX de verdad (modo `app`, sobre `fixtures/figuras-app`): `cargo test -p lv-core --features tex`.
//! Cubre los criterios de aceptación de F6 que no dependen del libro: nombres `<sello>-<slug>-<n>` por archivo, una figura nueva
//! sólo recocina las de su archivo, un cambio de estilo recocina todo y deshacerlo no recocina nada, la raíz del proyecto queda
//! limpia, y la figura de un `tikzpicture` fuera de `figure` no se externaliza.
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::build::BuildEvent;
use lv_core::figcache;
use lv_core::session::Session;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn copiar(de: &Path, a: &Path) {
    fs::create_dir_all(a).unwrap();
    for e in fs::read_dir(de).unwrap().flatten() {
        let (p, n) = (e.path(), e.file_name());
        if p.is_dir() {
            copiar(&p, &a.join(&n));
        } else {
            fs::copy(&p, a.join(&n)).unwrap();
        }
    }
}

struct Caso {
    _t: TempDir,
    p: PathBuf,
    s: Arc<Session>,
    r: Recolector,
}

fn caso() -> Caso {
    let t = TempDir::new().unwrap();
    let p = t.path().join("figuras app");
    copiar(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("figuras-app"), &p);
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();
    Caso { _t: t, p, s, r }
}

impl Caso {
    fn esperar_ocioso(&self) {
        let t = Instant::now();
        std::thread::sleep(Duration::from_millis(300));
        while self.s.is_building() {
            assert!(t.elapsed() < Duration::from_secs(280), "no terminó: {:?}", self.secuencia());
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn secuencia(&self) -> Vec<String> {
        self.r
            .eventos
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                BuildEvent::BakeListing { fase, .. } => Some(format!("listando({fase})")),
                BuildEvent::BakeStarted { total, .. } => Some(format!("cocinar({total})")),
                BuildEvent::BakeFinished { ok, cooked, .. } => Some(format!("cocido(ok={ok},{cooked})")),
                BuildEvent::Started { perfil, .. } => Some(format!("build({perfil})")),
                BuildEvent::Finished { perfil, ok, .. } => Some(format!("fin({perfil},ok={ok})")),
                _ => None,
            })
            .collect()
    }

    fn compilar(&self, perfil: &str) {
        self.s.request_build(Some(perfil)).unwrap();
        self.esperar_ocioso();
    }

    fn sello(&self) -> String {
        figcache::sello(&self.p, &["estilo.tex".to_string()]).unwrap()
    }

    fn pdfs(&self) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(self.p.join("figuras-cache"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".pdf"))
            .collect();
        v.sort();
        v
    }

    /// Cuántas subcompilaciones de figuras lanzó pgf en todo lo que va del log.
    fn invocaciones(&self) -> usize {
        self.r.log().matches("-jobname \"figuras-cache/").count()
    }

    fn escribir(&self, rel: &str, t: &str) {
        fs::write(self.p.join(rel), t).unwrap();
    }

    fn leer(&self, rel: &str) -> String {
        fs::read_to_string(self.p.join(rel)).unwrap()
    }
}

#[test]
fn las_figuras_se_nombran_por_archivo_y_la_raiz_queda_limpia() {
    let c = caso();
    c.compilar("completo");
    let s = c.sello();
    assert_eq!(c.pdfs(), [format!("{s}-cap-a-0.pdf"), format!("{s}-cap-a-1.pdf"), format!("{s}-cap-b-0.pdf"), format!("{s}-main-0.pdf")], "{:?}", c.secuencia());
    // `main-1` sería el `tikzpicture` con `remember picture, overlay` fuera de `figure`: no se externaliza.
    assert!(c.secuencia().iter().any(|e| e == "fin(completo,ok=true)"), "{:?}", c.secuencia());
    let mut sobras: Vec<String> = fs::read_dir(&c.p).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    sobras.sort();
    assert_eq!(sobras, [".lv", "Secciones", "cap-a.tex", "estilo.tex", "figuras-cache", "latexviewer.json", "main.tex"], "las subcompilaciones no ensucian la raíz");
    assert_eq!(fs::read_dir(c.p.join("Secciones")).unwrap().count(), 1, "ni la carpeta del \\include (el .aux queda en el perfil)");
    let st = c.s.figures_status().unwrap();
    assert_eq!((st.actuales, st.viejas, st.pendientes, st.fallidas), (4, 0, 0, 0), "{st:?}");
    let archivos: Vec<_> = st.figuras.iter().map(|f| f.archivo.clone().unwrap_or_default()).collect();
    assert!(archivos.contains(&"cap-a.tex".to_string()) && archivos.contains(&"Secciones/cap-b.tex".to_string()) && archivos.contains(&"main.tex".to_string()), "{archivos:?}");
}

#[test]
fn una_figura_nueva_recocina_solo_las_de_su_archivo_y_un_cambio_chico_solo_la_que_cambio() {
    let c = caso();
    c.compilar("completo");
    let antes = c.invocaciones();
    // Una figura nueva ARRIBA de las de cap-a: corre el número de las que le siguen en ese archivo, y de ningún otro.
    let cap = c.leer("cap-a.tex");
    let nueva = "\\begin{figure}[ht]\n  \\centering\n  \\begin{tikzpicture}\n    \\draw[miestilo] (0,0) circle (0.5);\n  \\end{tikzpicture}\n  \\caption{Nueva.}\n\\end{figure}\n\n";
    c.escribir("cap-a.tex", &cap.replacen("\\begin{figure}[ht]", &format!("{nueva}\\begin{{figure}}[ht]"), 1));
    c.compilar("completo");
    assert_eq!(c.invocaciones() - antes, 3, "las 3 de cap-a (la nueva y las dos que se corrieron), ninguna de main ni de cap-b");
    let s = c.sello();
    assert!(c.pdfs().contains(&format!("{s}-cap-a-2.pdf")));
    // Un cambio en el código de una sola figura de cap-b: sólo esa.
    let antes = c.invocaciones();
    c.escribir("Secciones/cap-b.tex", &c.leer("Secciones/cap-b.tex").replace("(2,1);\n    \\draw", "(3,1);\n    \\draw"));
    c.compilar("completo");
    assert_eq!(c.invocaciones() - antes, 1);
}

#[test]
fn un_cambio_de_estilo_recocina_todo_y_deshacerlo_no_recocina_nada() {
    let c = caso();
    c.compilar("completo");
    let original = c.leer("estilo.tex");
    let s1 = c.sello();
    // Cambia el estilo: cambia el sello y la cocción automática cocina las 4 antes del build.
    c.escribir("estilo.tex", &format!("{original}% cambio\n"));
    let s2 = c.sello();
    assert_ne!(s1, s2);
    let st = c.s.figures_status().unwrap();
    assert!(st.necesita_cocer, "ninguna figura del sello de hoy: hay que cocinar antes de compilar");
    let n = c.secuencia().len();
    c.compilar("completo");
    let nueva = &c.secuencia()[n..];
    assert_eq!(nueva[0], "listando(perfil completo)");
    assert_eq!(nueva[1], "cocinar(4)");
    assert!(nueva[2].starts_with("cocido(ok=true,4)"), "{nueva:?}");
    assert_eq!(nueva[3], "build(completo)");
    let st = c.s.figures_status().unwrap();
    assert_eq!((st.actuales, st.viejas), (4, 4), "las 4 nuevas y las 4 del sello anterior, todavía sin limpiar");
    // Deshacer el cambio: las del sello anterior siguen ahí y el build no cocina nada.
    c.escribir("estilo.tex", &original);
    assert_eq!(c.sello(), s1);
    assert!(!c.s.figures_status().unwrap().necesita_cocer);
    let antes = c.invocaciones();
    let n = c.secuencia().len();
    c.compilar("completo");
    assert_eq!(c.invocaciones(), antes, "volver al sello anterior no recocina nada");
    assert!(!c.secuencia()[n..].iter().any(|e| e.starts_with("listando")), "ni siquiera lista: {:?}", &c.secuencia()[n..]);
    // La limpieza (con una cocción completa del sello de hoy) se lleva las 4 del sello que ya no se usa.
    c.s.request_bake().unwrap();
    c.esperar_ocioso();
    let p = c.s.figures_clean_preview().unwrap();
    assert_eq!(p.figuras, 4, "{p:?}");
    let h = c.s.figures_clean().unwrap();
    assert!(h.archivos.iter().all(|a| a.contains(&s2)), "sólo del sello que ya no se usa: {h:?}");
    assert_eq!(c.pdfs().len(), 4);
}

#[test]
fn la_coccion_manual_en_paralelo_cocina_las_cuatro_y_el_build_siguiente_no_cocina_ninguna() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar_ocioso();
    assert_eq!(c.pdfs().len(), 4, "{:?}", c.secuencia());
    assert_eq!(c.secuencia()[..2], ["listando(todo)", "cocinar(4)"]);
    let antes = c.invocaciones();
    c.compilar("completo");
    assert_eq!(c.invocaciones(), antes, "el build encuentra todo cocinado: 0 subcompilaciones adentro");
    assert!(c.secuencia().iter().any(|e| e == "fin(completo,ok=true)"));
}
