//! Archivos que una figura lee desde adentro de su `tikzpicture` (`\input{datos}`), con TeX de verdad: `cargo test -p lv-core --features tex`.
//!
//! pgf decide si una figura cambió con el md5 del texto del dibujo tal como está escrito: con un `\input{datos}` adentro hashea esa
//! línea y no `datos.tex`, y latexmk tampoco lo ve porque con la figura en el cache el documento no abre el archivo. Sin la
//! invalidación de la app, cambiar `datos.tex` daba 0 subcompilaciones y la imagen idéntica. El fixture es `fixtures/figuras-datos`.
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
    let p = t.path().join("figuras datos");
    copiar(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("figuras-datos"), &p);
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

    fn escribir(&self, rel: &str, t: &str) {
        fs::write(self.p.join(rel), t).unwrap();
    }

    /// Cuántas subcompilaciones de figuras lanzó pgf en todo lo que va del log.
    fn invocaciones(&self) -> usize {
        self.r.log().matches("-jobname \"figuras-cache/").count()
    }

    fn sello(&self) -> String {
        figcache::sello(&self.p, &["estilo.tex".to_string()]).unwrap()
    }

    /// La caja del PDF de la figura `uno-0`: cambia si el dibujo cambia (el PDF lleva fechas, así que no se comparan los bytes).
    fn caja_de_uno(&self) -> String {
        let bytes = fs::read(self.p.join(format!("figuras-cache/{}-uno-0.pdf", self.sello()))).unwrap();
        let t = String::from_utf8_lossy(&bytes);
        let i = t.find("/MediaBox").expect("el PDF de la figura tiene MediaBox");
        t[i..].lines().next().unwrap().trim().to_string()
    }
}

#[test]
fn cambiar_un_archivo_que_una_figura_lee_con_input_recocina_esa_figura_y_ninguna_otra_en_un_perfil_normal() {
    let c = caso();
    // La primera vez la cocción automática (no hay figuras de este sello) cocina las dos antes del build, fuera de su log.
    c.compilar("rapido");
    assert_eq!(c.secuencia()[..3], ["listando(perfil rapido)", "cocinar(2)", "cocido(ok=true,2)"], "{:?}", c.secuencia());
    let base = c.invocaciones();
    let caja = c.caja_de_uno();
    // Sin cambios, ninguna.
    c.compilar("rapido");
    assert_eq!(c.invocaciones(), base);
    // Cambia el archivo de datos y nada más: la figura de `uno` se recocina (adentro del build, la lanza pgf), la de `dos` no, y la
    // imagen cambia.
    c.escribir("datos.tex", "\\draw[miestilo] (0,0) -- (3,3);\n");
    c.compilar("rapido");
    assert_eq!(c.invocaciones() - base, 1, "sólo la de `uno`; antes daba 0: {:?}", c.secuencia());
    assert_ne!(c.caja_de_uno(), caja, "la figura recocinada es la nueva");
    assert!(c.secuencia().last().is_some_and(|e| e == "fin(rapido,ok=true)"), "{:?}", c.secuencia());
    // El historial explica ese build: cambió un archivo que una figura lee, se borraron `.md5` y `.fdb_latexmk`, y pgf cocinó una figura.
    let h = c.s.history(5);
    let e = h.iter().find(|x| x.entrada.tipo == "build" && !x.entrada.datos_cambiados.is_empty()).expect("un build con datos cambiados");
    assert_eq!(e.entrada.datos_cambiados, ["datos.tex"]);
    assert_eq!((e.entrada.figuras_invalidadas, e.entrada.figuras_en_el_build.len()), (1, 1), "{:?}", e.entrada);
    assert!(e.entrada.herramientas.iter().any(|x| x.nombre == "pdflatex") && e.entrada.pasadas >= 1);
    assert!(e.pistas.iter().any(|p| p.contains("cambió datos.tex, que una figura lee desde adentro de su tikzpicture")), "{:?}", e.pistas);
    assert!(e.pistas.iter().any(|p| p.contains("1 figura cocinada por pgf dentro de la pasada")), "{:?}", e.pistas);
    // Y a partir de ahí vuelve a estar al día.
    c.compilar("rapido");
    assert_eq!(c.invocaciones() - base, 1);
}

#[test]
fn un_perfil_que_consume_el_cache_no_saltea_el_listado_si_cambio_un_archivo_que_una_figura_lee() {
    let c = caso();
    c.compilar("completo");
    assert_eq!(c.secuencia()[..3], ["listando(todo)", "cocinar(2)", "cocido(ok=true,2)"], "{:?}", c.secuencia());
    let caja = c.caja_de_uno();
    let n = c.secuencia().len();
    c.compilar("completo");
    assert_eq!(c.secuencia()[n..], ["build(completo)", "fin(completo,ok=true)"], "nada cambió: ni listado ni cocción");
    // Cambia el archivo de datos: la huella cambia, se lista, se cocina esa figura y recién después se compila.
    c.escribir("datos.tex", "\\draw[miestilo] (0,0) -- (3,3);\n");
    let n = c.secuencia().len();
    c.compilar("completo");
    assert_eq!(c.secuencia()[n..], ["listando(todo)", "cocinar(1)", "cocido(ok=true,1)", "build(completo)", "fin(completo,ok=true)"], "{:?}", c.secuencia());
    assert_ne!(c.caja_de_uno(), caja, "la figura recocinada es la nueva");
    // Al día otra vez: se saltea.
    let n = c.secuencia().len();
    c.compilar("completo");
    assert_eq!(c.secuencia()[n..], ["build(completo)", "fin(completo,ok=true)"]);
}
