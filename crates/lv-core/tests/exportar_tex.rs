//! Exportar partes, vista previa de un fragmento y variables, con TeX de verdad (F7): `cargo test -p lv-core --features tex`, sobre
//! `fixtures/exportar` (un libro de tres partes que arranca en el capítulo 5, una con un error a propósito).
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::build::BuildEvent;
use lv_core::config::StatePatch;
use lv_core::figcache;
use lv_core::session::Session;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
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
    let p = t.path().join("libro exportar");
    copiar(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("exportar"), &p);
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();
    Caso { _t: t, p, s, r }
}

impl Caso {
    fn esperar_ocioso(&self) {
        let t = Instant::now();
        std::thread::sleep(Duration::from_millis(300));
        while self.s.is_building() {
            assert!(t.elapsed() < Duration::from_secs(240), "no terminó: {:?}", self.eventos_clave());
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn eventos_clave(&self) -> Vec<String> {
        self.r
            .eventos
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                BuildEvent::Started { perfil, .. } => Some(format!("build({perfil})")),
                BuildEvent::Finished { perfil, ok, .. } => Some(format!("fin({perfil},ok={ok})")),
                BuildEvent::ExportStarted { total, .. } => Some(format!("exportando({total})")),
                BuildEvent::ExportProgress { num, ok, part, .. } => Some(format!("parte({part},n={},ok={ok})", num.clone().unwrap_or_default())),
                BuildEvent::ExportFinished { ok, exported, failed, cancelled, .. } => Some(format!("exportado(ok={ok},{exported},{failed},canc={cancelled})")),
                BuildEvent::ExportQueued => Some("espera(exportar)".into()),
                _ => None,
            })
            .collect()
    }

    fn compilar(&self, perfil: &str) {
        self.s.request_build(Some(perfil)).unwrap();
        self.esperar_ocioso();
    }

    fn seleccion(&self, partes: &[&str]) {
        self.s.set_state(StatePatch { selection: Some(partes.iter().map(|s| s.to_string()).collect()), ..Default::default() }).unwrap();
    }

    /// Un parcial con las dos partes buenas: deja los `.aux` que siembran las referencias de los builds de servicio.
    fn sembrar(&self) {
        self.seleccion(&["Cap/uno", "Cap/dos"]);
        self.compilar("parcial");
    }

    fn texto_de(&self, rel: &str) -> String {
        let o = Command::new("pdftotext").arg(self.p.join(rel)).arg("-").output().expect("pdftotext (viene con MiKTeX)");
        String::from_utf8_lossy(&o.stdout).to_string()
    }

    fn sello(&self) -> String {
        figcache::sello(&self.p, &["estilo.tex".to_string()]).unwrap()
    }

    fn mtime(&self, rel: &str) -> std::time::SystemTime {
        fs::metadata(self.p.join(rel)).and_then(|m| m.modified()).unwrap()
    }
}

#[test]
fn exportar_deja_un_pdf_por_parte_con_el_numero_impreso_y_no_toca_la_seleccion_ni_el_pdf_del_parcial() {
    let c = caso();
    c.sembrar();
    let parcial = ".lv/build/parcial/lv-parcial.pdf";
    let (antes, seleccion) = (c.mtime(parcial), c.s.view().unwrap().state.selection);
    c.s.request_export(Some(vec!["Cap/uno".into(), "Cap/dos".into()])).unwrap();
    c.esperar_ocioso();
    let ev = c.eventos_clave();
    assert!(ev.iter().any(|e| e == "exportado(ok=true,2,0,canc=false)"), "{ev:?}");
    // El número es el impreso (el libro arranca en el 5), no la posición (1 y 2).
    assert!(ev.contains(&"parte(Cap/uno,n=5,ok=true)".to_string()) && ev.contains(&"parte(Cap/dos,n=6,ok=true)".to_string()), "{ev:?}");
    for f in ["salida/pdf/05 - uno.pdf", "salida/pdf/06 - dos.pdf"] {
        assert!(fs::read(c.p.join(f)).unwrap().starts_with(b"%PDF"), "{f}");
    }
    // Las referencias del capítulo exportado salen resueltas con el `.aux` sembrado del otro perfil.
    assert!(c.texto_de("salida/pdf/06 - dos.pdf").contains("capitulo 5"), "{}", c.texto_de("salida/pdf/06 - dos.pdf"));
    // Ni la selección ni el PDF del parcial cambiaron, y los `Finished` internos no salen como builds del usuario.
    assert_eq!(c.s.view().unwrap().state.selection, seleccion);
    assert_eq!(c.mtime(parcial), antes);
    assert_eq!(ev.iter().filter(|e| e.starts_with("fin(export")).count(), 0, "{ev:?}");
    assert_eq!(ev.iter().filter(|e| *e == "build(export)").count(), 2, "un build por parte: {ev:?}");
}

#[test]
fn una_parte_que_falla_no_corta_las_demas_y_queda_su_error_en_los_problemas_del_perfil_export() {
    let c = caso();
    c.sembrar();
    c.s.request_export(None).unwrap(); // todas: uno, dos y roto
    c.esperar_ocioso();
    let ev = c.eventos_clave();
    assert!(ev.iter().any(|e| e == "exportado(ok=false,2,1,canc=false)"), "{ev:?}");
    assert!(ev.iter().any(|e| e.starts_with("parte(Cap/roto,") && e.ends_with("ok=false)")), "{ev:?}");
    assert!(c.p.join("salida/pdf/05 - uno.pdf").is_file() && c.p.join("salida/pdf/06 - dos.pdf").is_file());
    assert!(!c.p.join("salida/pdf").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("roto")));
    let problemas = c.s.problems("export");
    assert!(problemas.iter().any(|p| p.file.as_deref() == Some("Cap/roto.tex") && p.context.contains("comandoQueNoExiste")), "{problemas:?}");
}

#[test]
fn cancelar_a_mitad_de_una_exportacion_corta_el_build_y_no_lanza_las_que_faltan() {
    let c = caso();
    c.sembrar();
    c.s.request_export(None).unwrap();
    let t = Instant::now();
    while !c.eventos_clave().iter().any(|e| e == "build(export)") {
        assert!(t.elapsed() < Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(c.s.cancel());
    c.esperar_ocioso();
    let ev = c.eventos_clave();
    let fin = ev.iter().find(|e| e.starts_with("exportado(")).unwrap_or_else(|| panic!("{ev:?}"));
    assert!(fin.contains("canc=true"), "{ev:?}");
    assert!(ev.iter().filter(|e| *e == "build(export)").count() < 3, "no se siguen lanzando partes: {ev:?}");
    // Después de cancelar la cola está libre: un build normal corre.
    c.compilar("parcial");
    assert!(c.eventos_clave().last().is_some_and(|e| e == "fin(parcial,ok=true)"));
}

#[test]
fn una_exportacion_y_un_fragmento_pedidos_durante_un_build_esperan_en_la_cola_y_corren_despues_en_orden() {
    use lv_core::session::BuildAck;
    let c = caso();
    c.sembrar();
    let n = c.eventos_clave().len();
    assert!(matches!(c.s.request_build(Some("parcial")).unwrap(), BuildAck::Started { .. }));
    assert!(matches!(c.s.request_export(Some(vec!["Cap/uno".into()])).unwrap(), BuildAck::Queued));
    assert!(matches!(c.s.request_fragment("Un fragmento.".into()).unwrap(), BuildAck::Queued));
    c.esperar_ocioso();
    let ev = &c.eventos_clave()[n..];
    // Primero el build que estaba corriendo; después el fragmento (lo que se está esperando mirar) y recién después la exportación.
    let orden: Vec<&String> = ev.iter().filter(|e| e.starts_with("fin(") || e.starts_with("exportado(")).collect();
    assert_eq!(orden, ["fin(parcial,ok=true)", "fin(fragmento,ok=true)", "exportado(ok=true,1,0,canc=false)"], "{ev:?}");
    assert!(ev.contains(&"espera(exportar)".to_string()), "{ev:?}");
}

#[test]
fn la_vista_previa_de_un_fragmento_resuelve_referencias_y_comparte_el_cache_sin_pisar_las_figuras_del_capitulo() {
    let c = caso();
    c.sembrar();
    let sello = c.sello();
    let figura_del_capitulo = format!("figuras-cache/{sello}-uno-0.pdf");
    assert!(c.p.join(&figura_del_capitulo).is_file(), "el parcial cocinó la figura del capítulo");
    let (mtime, seleccion) = (c.mtime(&figura_del_capitulo), c.s.view().unwrap().state.selection);
    let texto = "Como dice el capitulo \\ref{cap:uno}:\n\\begin{figure}[ht]\n\\begin{tikzpicture}\\draw[miestilo] (0,0) rectangle (2,1);\\end{tikzpicture}\n\\caption{Del fragmento.}\n\\end{figure}\n";
    c.s.request_fragment(texto.into()).unwrap();
    c.esperar_ocioso();
    let ev = c.eventos_clave();
    assert_eq!(ev.last().map(String::as_str), Some("fin(fragmento,ok=true)"), "{ev:?}");
    let pdf = ".lv/build/fragmento/lv-fragmento.pdf";
    assert!(fs::read(c.p.join(pdf)).unwrap().starts_with(b"%PDF"));
    let t = c.texto_de(pdf);
    assert!(t.contains("capitulo 5") && t.contains("Del fragmento"), "referencia resuelta: {t}");
    // La figura del fragmento va con su slug y el sello de hoy; la del capítulo no se tocó, ni la selección.
    assert!(c.p.join(format!("figuras-cache/{sello}-frag-0.pdf")).is_file());
    assert_eq!(c.mtime(&figura_del_capitulo), mtime);
    assert_eq!(c.s.view().unwrap().state.selection, seleccion);
    // Pedirlo de nuevo con el mismo texto no recocina la figura.
    let antes = c.r.log().matches("-jobname \"figuras-cache/").count();
    c.s.request_fragment(texto.into()).unwrap();
    c.esperar_ocioso();
    assert_eq!(c.r.log().matches("-jobname \"figuras-cache/").count(), antes, "figura del fragmento al día");
}

#[test]
fn la_variable_del_menu_llega_al_documento_porque_la_guardia_deja_ganar_al_driver() {
    let c = caso();
    c.seleccion(&["Cap/uno"]);
    let pie = |valor: &str| {
        let mut v = BTreeMap::new();
        v.insert("OpcionPie".to_string(), valor.to_string());
        c.s.set_state(StatePatch { variables: Some(v), ..Default::default() }).unwrap();
        c.compilar("parcial");
        c.texto_de(".lv/build/parcial/lv-parcial.pdf")
    };
    assert!(pie("ninguno").contains("Pie:ninguno"));
    assert!(pie("autor").contains("Pie:autor"), "el cambio de variable recompila (cambia el driver)");
    // Una opción que el proyecto no declara se rechaza.
    let mut malo = BTreeMap::new();
    malo.insert("OpcionPie".to_string(), "inventada".to_string());
    assert!(c.s.set_state(StatePatch { variables: Some(malo), ..Default::default() }).is_err());
}
