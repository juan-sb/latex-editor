//! La cocción de figuras dentro de la sesión (F6), con un latexmk y un pdflatex falsos de PowerShell: no hace falta TeX.
//! Orden de los trabajos, disparo automático, ceder el paso a un build, cancelar, estado y limpieza. Con TeX de verdad, en
//! `tests/figuras_rotas.rs` y `tests/figuras_tex.rs` (`--features tex`).
#![cfg(windows)]

mod comun;

use comun::Recolector;
use lv_core::build::{BuildEvent, Builder};
use lv_core::cocinero::Cocinero;
use lv_core::figcache;
use lv_core::session::{BuildAck, Session};
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const CONFIG: &str = r#"{
  "root": "main.tex",
  "parts": { "commands": ["include"] },
  "flags": { "partial": ["CompilacionReducida"], "externalize": ["TikzExternalizar"], "figureList": ["TikzListaYMake"] },
  "figureCache": { "mode": "project", "dir": "figuras-cache", "stampFiles": ["estilo.tex"], "parallelJobs": 2 },
  "profiles": {
    "parcial":  { "partial": true, "externalize": true, "parts": "selection" },
    "rapido":   { "partial": true, "externalize": true, "parts": "all" },
    "completo": { "cleanBefore": true, "autoCompile": false },
    "revision": { "externalize": true, "cacheOnly": true, "autoCompile": false }
  }
}"#;

/// Un latexmk que cuenta una pasada y deja el PDF del perfil.
const OK: &str = "$p = $env:LV_PERFIL\n$d = \".lv/build/$p\"\nNew-Item -ItemType Directory -Force $d | Out-Null\n\"Run number 1 of rule 'pdflatex'\"\nSet-Content \"$d/lv-$p.pdf\" 'x'\n";

/// Un "pdflatex" falso. Con `-output-directory` es el listado: escribe la figlist con 4 figuras del sello que dice `sello.txt`
/// (2 de `uno` y 2 de `dos`, los slugs de `\FigurasDe` de los capítulos) y el `.md5` de cada una (que cambia con `version.txt`).
/// Si el driver tiene `\includeonly` lista sólo las de las partes que nombra. Con `-jobname=` es una subcompilación que tarda lo
/// que diga `demora.txt` (ms) y deja el PDF y el log. Todo lo que lanza queda anotado en `lanzadas/`.
const MOTOR_FALSO: &str = r##"$job = $null; $out = $null; $driver = $null
foreach ($a in $args) {
  if ($a -like '-jobname=*') { $job = $a.Substring(9) }
  if ($a -like '-output-directory=*') { $out = $a.Substring(18) }
  if ($a -like '*.tex') { $driver = $a }
}
# Un archivo por anotación (con las ticks por delante para ordenarlas): con dos procesos a la vez, `Add-Content` a un mismo archivo pierde líneas.
function Anotar($texto) {
  New-Item -ItemType Directory -Force 'lanzadas' | Out-Null
  Set-Content ("lanzadas/{0}-{1}.txt" -f [DateTime]::UtcNow.Ticks, [guid]::NewGuid().ToString('N').Substring(0, 6)) $texto
}
$sello = (Get-Content 'sello.txt' -Raw).Trim()
$version = if (Test-Path 'version.txt') { (Get-Content 'version.txt' -Raw).Trim() } else { '1' }
if ($out) {
  $texto = Get-Content $driver -Raw
  Anotar "LISTADO $driver"
  New-Item -ItemType Directory -Force "$out/figuras-cache" | Out-Null
  $nombres = @()
  if ($texto -notmatch 'includeonly' -or $texto -match 'Secciones/Uno') { $nombres += "figuras-cache/$sello-uno-0", "figuras-cache/$sello-uno-1" }
  if ($texto -notmatch 'includeonly' -or $texto -match 'Secciones/Dos') { $nombres += "figuras-cache/$sello-dos-0", "figuras-cache/$sello-dos-1" }
  Set-Content "$out/lv-cocina.figlist" $nombres
  foreach ($n in $nombres) { Set-Content "$out/$n.md5" "$n-v$version" }
  exit 0
}
Anotar "FIGURA $job"
$demora = if (Test-Path 'demora.txt') { [int](Get-Content 'demora.txt' -Raw).Trim() } else { 50 }
Start-Sleep -Milliseconds $demora
Set-Content "$job.pdf" "%PDF-1.5`n%%EOF"
Set-Content "$job.log" 'This is pdfTeX'
"##;

fn script(contenido: &str) -> std::path::PathBuf {
    let fuera = TempDir::new().unwrap();
    let ruta = fuera.path().join("falso.ps1");
    fs::write(&ruta, contenido).unwrap();
    std::mem::forget(fuera);
    ruta
}

fn args_de(s: &Path) -> Vec<OsString> {
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].iter().map(OsString::from).chain([s.as_os_str().to_owned()]).collect()
}

struct Caso {
    d: TempDir,
    s: Arc<Session>,
    r: Recolector,
}

fn caso() -> Caso {
    let d = TempDir::new().unwrap();
    let e = |rel: &str, t: &str| {
        let p = d.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, t).unwrap();
    };
    e("main.tex", "\\documentclass{book}\n\\begin{document}\n\\include{Secciones/Uno}\n\\include{Secciones/Dos}\n\\end{document}\n");
    e("Secciones/Uno.tex", "\\FigurasDe{uno}\nuno\n");
    e("Secciones/Dos.tex", "\\FigurasDe{dos}\ndos\n");
    e("estilo.tex", "estilo 1\n");
    e("latexviewer.json", CONFIG);
    let sello = figcache::sello(d.path(), &["estilo.tex".to_string()]).unwrap();
    e("sello.txt", &sello);
    let r = Recolector::nuevo();
    let latexmk = Builder::con_programa("powershell", args_de(&script(OK)));
    let motor = Cocinero::con_programa("powershell", args_de(&script(MOTOR_FALSO)));
    let s = Session::open_with_cocinero(d.path(), r.sink.clone(), latexmk, motor).unwrap();
    Caso { d, s, r }
}

impl Caso {
    fn sello(&self) -> String {
        fs::read_to_string(self.d.path().join("sello.txt")).unwrap().trim().to_string()
    }

    fn escribir(&self, rel: &str, t: &str) {
        fs::write(self.d.path().join(rel), t).unwrap();
    }

    /// Cambia el archivo de estilo (y el sello con el que el motor falso nombra las figuras).
    fn cambiar_estilo(&self, n: u32) {
        self.escribir("estilo.tex", &format!("estilo {n}\n"));
        let sello = figcache::sello(self.d.path(), &["estilo.tex".to_string()]).unwrap();
        self.escribir("sello.txt", &sello);
    }

    fn eventos(&self) -> Vec<BuildEvent> {
        self.r.eventos.lock().unwrap().clone()
    }

    /// Una etiqueta corta por evento que importa, en orden, para comparar secuencias.
    fn secuencia(&self) -> Vec<String> {
        self.eventos()
            .iter()
            .filter_map(|e| match e {
                BuildEvent::BakeListing { fase, .. } => Some(format!("listando({fase})")),
                BuildEvent::BakeStarted { total, .. } => Some(format!("cocinar({total})")),
                BuildEvent::BakeFinished { ok, cancelled, ceded, .. } => Some(format!("cocido(ok={ok},canc={cancelled},cedio={ceded})")),
                BuildEvent::Started { perfil, .. } => Some(format!("build({perfil})")),
                BuildEvent::Finished { perfil, .. } => Some(format!("fin({perfil})")),
                BuildEvent::Queued { perfil } => Some(format!("espera({perfil})")),
                BuildEvent::BakeQueued => Some("espera(figuras)".into()),
                _ => None,
            })
            .collect()
    }

    fn esperar(&self, que: &str, seg: u64, cond: impl Fn(&Caso) -> bool) {
        let t = Instant::now();
        while !cond(self) {
            assert!(t.elapsed() < Duration::from_secs(seg), "tiempo agotado esperando {que}; pasó: {:?}", self.secuencia());
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    /// Nada corriendo ni esperando.
    fn ocioso(&self) -> bool {
        !self.s.is_building()
    }

    /// Lo que lanzó el motor falso, en orden de lanzamiento.
    fn lanzadas(&self) -> Vec<String> {
        let mut v: Vec<(String, String)> = fs::read_dir(self.d.path().join("lanzadas"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().to_string(), fs::read_to_string(e.path()).unwrap_or_default().trim().to_string()))
            .collect();
        v.sort();
        v.into_iter().map(|(_, t)| t).collect()
    }

    fn figura(&self, corto: &str, ext: &str) -> std::path::PathBuf {
        self.d.path().join(format!("figuras-cache/{}-{corto}.{ext}", self.sello()))
    }
}

#[test]
fn la_coccion_manual_lista_cocina_instala_los_md5_y_deja_el_estado_al_dia() {
    let c = caso();
    assert!(matches!(c.s.request_bake().unwrap(), BuildAck::Started { .. }));
    c.esperar("que termine la cocción", 60, |c| c.secuencia().iter().any(|e| e.starts_with("cocido(")) && c.ocioso());
    assert_eq!(c.secuencia(), ["listando(todo)", "cocinar(4)", "cocido(ok=true,canc=false,cedio=false)"]);
    let sello = c.sello();
    for n in ["uno-0", "uno-1", "dos-0", "dos-1"] {
        assert!(c.figura(n, "pdf").is_file(), "{n}.pdf");
        assert_eq!(fs::read_to_string(c.figura(n, "md5")).unwrap().trim(), format!("figuras-cache/{sello}-{n}-v1"), "se instala el md5 del listado, recién verificada la figura");
    }
    // El listado usó el driver de cocina con todas las partes y los tres flags.
    let driver = fs::read_to_string(c.d.path().join(".lv/drivers/lv-cocina.tex")).unwrap();
    assert!(driver.contains("\\def\\CompilacionReducida{}") && driver.contains("\\def\\TikzExternalizar{}") && driver.contains("\\def\\TikzListaYMake{}"), "{driver}");
    assert!(!driver.contains("includeonly"), "el listado de todo el documento no lleva includeonly: {driver}");
    let st = c.s.figures_status().unwrap();
    assert_eq!((st.actuales, st.pendientes, st.fallidas), (4, 0, 0));
    assert_eq!(st.sello.as_deref(), Some(sello.as_str()));
    assert!(st.figlist.as_ref().is_some_and(|f| f.completa && f.del_sello_de_hoy && f.total == 4));
    assert!(st.figuras.iter().all(|f| f.estado == "aldia"));
    let por_archivo: Vec<(String, String)> = st.figuras.iter().map(|f| (f.slug.clone().unwrap(), f.archivo.clone().unwrap())).collect();
    assert_eq!(por_archivo[0], ("uno".to_string(), "Secciones/Uno.tex".to_string()));
    assert_eq!(por_archivo[3], ("dos".to_string(), "Secciones/Dos.tex".to_string()));
}

#[test]
fn una_segunda_coccion_sin_cambios_no_lanza_ninguna_subcompilacion() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar("la primera cocción", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    let n = c.lanzadas().iter().filter(|l| l.starts_with("FIGURA")).count();
    assert_eq!(n, 4);
    c.s.request_bake().unwrap();
    c.esperar("la segunda cocción", 60, |c| c.ocioso() && c.secuencia().len() == 6);
    assert_eq!(c.lanzadas().iter().filter(|l| l.starts_with("FIGURA")).count(), 4, "al día: pendiente es sólo lo que falta o cambió");
    assert_eq!(c.secuencia()[4], "cocinar(0)");
    // Cambia el código de una figura (su md5 del listado): sólo esa se recocina... el motor falso cambia todos con la versión.
    c.escribir("version.txt", "2");
    c.s.request_bake().unwrap();
    c.esperar("la tercera cocción", 60, |c| c.ocioso() && c.secuencia().len() == 9);
    assert_eq!(c.secuencia()[7], "cocinar(4)", "el md5 del listado difiere en contenido del compartido: pendiente");
}

#[test]
fn un_cambio_de_estilo_cocina_primero_las_figuras_del_perfil_despues_el_build_y_despues_el_resto() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar("la primera cocción", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    // Parcial con la selección por defecto: sólo la parte Uno.
    c.cambiar_estilo(2);
    assert!(matches!(c.s.request_build(Some("parcial")).unwrap(), BuildAck::Started { .. }));
    c.esperar("todo el ciclo", 90, |c| c.ocioso() && c.secuencia().len() >= 10);
    assert_eq!(
        c.secuencia()[3..],
        [
            "listando(perfil parcial)",
            "cocinar(2)",
            "cocido(ok=true,canc=false,cedio=false)",
            "build(parcial)",
            "fin(parcial)",
            "listando(todo)",
            "cocinar(2)",
            "cocido(ok=true,canc=false,cedio=false)",
        ],
        "primero las 2 figuras de Uno, después el build, y recién después las 2 de Dos"
    );
    // La cocción del perfil no tocó Dos mientras el build esperaba: el orden de las subcompilaciones lo dice.
    let figuras: Vec<String> = c.lanzadas().into_iter().filter(|l| l.starts_with("FIGURA")).skip(4).collect();
    assert_eq!(figuras.len(), 4);
    assert!(figuras[0].contains("uno") && figuras[1].contains("uno") && figuras[2].contains("dos") && figuras[3].contains("dos"), "{figuras:?}");
    let parcial = fs::read_to_string(c.d.path().join(".lv/drivers/lv-cocina.tex")).unwrap();
    assert!(!parcial.contains("includeonly"), "el último listado fue el de todo el documento: {parcial}");
    let st = c.s.figures_status().unwrap();
    assert_eq!((st.actuales, st.viejas), (4, 4), "las 4 del sello nuevo y las 4 viejas, todavía sin limpiar");
}

#[test]
fn un_perfil_de_todas_las_partes_no_pide_un_segundo_listado_del_resto() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar("la primera cocción", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    c.cambiar_estilo(2);
    assert!(matches!(c.s.request_build(Some("rapido")).unwrap(), BuildAck::Started { .. }));
    c.esperar("el ciclo", 90, |c| c.ocioso() && c.secuencia().len() >= 8);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        c.secuencia()[3..],
        ["listando(perfil rapido)", "cocinar(4)", "cocido(ok=true,canc=false,cedio=false)", "build(rapido)", "fin(rapido)"],
        "el listado del perfil ya fue el del documento entero: no hay resto"
    );
    assert!(c.s.figures_status().unwrap().figlist.is_some_and(|f| f.completa), "y esa lista autoriza a limpiar, como la de todo");
}

#[test]
fn un_perfil_que_solo_consume_el_cache_cocina_antes_y_saltea_el_listado_mientras_nada_cambie() {
    let c = caso();
    let secuencia = |c: &Caso| c.secuencia();
    // La primera vez no hay lista: lista, cocina todo y después compila.
    assert!(matches!(c.s.request_build(Some("revision")).unwrap(), BuildAck::Started { .. }));
    c.esperar("el primer ciclo", 60, |c| c.ocioso() && secuencia(c).len() >= 5);
    assert_eq!(secuencia(&c), ["listando(todo)", "cocinar(4)", "cocido(ok=true,canc=false,cedio=false)", "build(revision)", "fin(revision)"]);
    let driver = fs::read_to_string(c.d.path().join(".lv/drivers/lv-revision.tex")).unwrap();
    assert!(driver.contains("external/mode=graphics if exists"), "{driver}");

    // Sin cambios, y con un cambio de texto en un capítulo: ni listado ni cocción, sólo el build.
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el build sin cambios", 60, |c| c.ocioso() && secuencia(c).len() >= 7);
    c.escribir("Secciones/Uno.tex", "\\FigurasDe{uno}\nuno, con una palabra más\n");
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el build con un cambio de texto", 60, |c| c.ocioso() && secuencia(c).len() >= 9);
    assert_eq!(secuencia(&c)[5..], ["build(revision)", "fin(revision)", "build(revision)", "fin(revision)"]);
    assert_eq!(c.lanzadas().iter().filter(|l| l.starts_with("LISTADO")).count(), 1, "un solo listado en todo el recorrido");

    // Una figura nueva (o editada) en un capítulo cambia la huella: vuelve a listar antes de compilar.
    c.escribir("Secciones/Uno.tex", "\\FigurasDe{uno}\n\\begin{figure}\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\\end{figure}\n");
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el ciclo con la figura", 60, |c| c.ocioso() && secuencia(c).len() >= 14);
    assert_eq!(secuencia(&c)[9..], ["listando(todo)", "cocinar(0)", "cocido(ok=true,canc=false,cedio=false)", "build(revision)", "fin(revision)"]);
    // Y con la lista otra vez cocida del todo, se saltea de nuevo.
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el build que sigue", 60, |c| c.ocioso() && secuencia(c).len() >= 16);
    assert_eq!(secuencia(&c)[14..], ["build(revision)", "fin(revision)"]);

    // Un cambio de estilo cambia el sello: lista de nuevo. Un PDF borrado del cache, también.
    c.cambiar_estilo(2);
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el ciclo del estilo", 90, |c| c.ocioso() && secuencia(c).len() >= 21);
    assert_eq!(secuencia(&c)[16], "listando(todo)");
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el build sin cambios", 60, |c| c.ocioso() && secuencia(c).len() >= 23);
    fs::remove_file(c.figura("uno-0", "pdf")).unwrap();
    c.s.request_build(Some("revision")).unwrap();
    c.esperar("el ciclo con el PDF borrado", 90, |c| c.ocioso() && secuencia(c).len() >= 28);
    assert_eq!(secuencia(&c)[23..], ["listando(todo)", "cocinar(1)", "cocido(ok=true,canc=false,cedio=false)", "build(revision)", "fin(revision)"]);
    assert!(c.figura("uno-0", "pdf").is_file());
}

#[test]
fn un_perfil_que_consume_el_cache_no_publica() {
    let c = caso();
    c.escribir("latexviewer.json", &CONFIG.replace("\"parallelJobs\": 2 }", "\"parallelJobs\": 2 },\n  \"publish\": { \"dir\": \"PDF\" }"));
    let s = Session::open_with_cocinero(
        c.d.path(),
        c.r.sink.clone(),
        Builder::con_programa("powershell", args_de(&script(OK))),
        Cocinero::con_programa("powershell", args_de(&script(MOTOR_FALSO))),
    )
    .unwrap();
    let e = s.publish("revision").unwrap_err().to_string();
    assert!(e.contains("no publica"), "{e}");
}

#[test]
fn el_listado_del_perfil_lleva_el_includeonly_de_su_seleccion() {
    let c = caso();
    c.cambiar_estilo(2);
    c.s.request_build(Some("parcial")).unwrap();
    c.esperar("el listado del perfil", 60, |c| c.lanzadas().iter().any(|l| l.starts_with("LISTADO")));
    let t = Instant::now();
    // El driver de cocina del listado parcial, antes de que el listado de todo lo pise.
    let mut visto = String::new();
    while t.elapsed() < Duration::from_secs(20) && !visto.contains("includeonly") {
        visto = fs::read_to_string(c.d.path().join(".lv/drivers/lv-cocina.tex")).unwrap_or_default();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(visto.contains("\\includeonly{Secciones/Uno}"), "{visto}");
    c.esperar("el final", 90, |c| c.ocioso() && c.secuencia().len() >= 7);
}

#[test]
fn sin_cambio_de_estilo_el_build_no_lleva_cocina_antes() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar("la cocción", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    c.s.request_build(Some("parcial")).unwrap();
    c.esperar("el build", 60, |c| c.ocioso() && c.secuencia().len() == 5);
    assert_eq!(c.secuencia()[3..], ["build(parcial)", "fin(parcial)"], "hay figuras de este sello: no hace falta cocinar antes");
}

#[test]
fn un_build_que_llega_durante_la_coccion_del_resto_la_hace_ceder_y_despues_la_retoma() {
    let c = caso();
    c.escribir("demora.txt", "600");
    // jobs=2 en la config: 4 figuras de 600 ms son dos tandas. El build llega en la primera.
    c.s.request_bake().unwrap();
    c.esperar("el comienzo de la cocción", 30, |c| c.secuencia().iter().any(|e| e.starts_with("cocinar(")));
    assert!(matches!(c.s.request_build(Some("rapido")).unwrap(), BuildAck::Queued));
    c.esperar("todo el ciclo", 90, |c| c.ocioso() && c.secuencia().iter().filter(|e| e.starts_with("cocido(")).count() == 2);
    assert_eq!(
        c.secuencia(),
        [
            "listando(todo)",
            "cocinar(4)",
            "espera(rapido)",
            "cocido(ok=true,canc=false,cedio=true)",
            "build(rapido)",
            "fin(rapido)",
            "listando(todo)",
            "cocinar(2)",
            "cocido(ok=true,canc=false,cedio=false)",
        ],
        "cede el paso (espera las que estaban en vuelo), corre el build y retoma sólo lo que faltaba"
    );
    for n in ["uno-0", "uno-1", "dos-0", "dos-1"] {
        assert!(c.figura(n, "pdf").is_file(), "{n}: entre las dos tandas se cocinaron todas");
    }
}

#[test]
fn cancelar_mata_la_coccion_no_deja_pendientes_y_no_corre_el_build_que_esperaba() {
    let c = caso();
    c.escribir("demora.txt", "5000");
    c.s.request_bake().unwrap();
    c.esperar("que arranque la cocción", 30, |c| c.secuencia().iter().any(|e| e.starts_with("cocinar(")));
    c.esperar("que lance figuras", 30, |c| c.lanzadas().iter().any(|l| l.starts_with("FIGURA")));
    assert!(matches!(c.s.request_build(Some("rapido")).unwrap(), BuildAck::Queued));
    let t = Instant::now();
    assert!(c.s.cancel());
    c.esperar("el final de la cocción cancelada", 30, |c| c.ocioso());
    assert!(t.elapsed() < Duration::from_secs(4), "cancelar no espera a las subcompilaciones: {:?}", t.elapsed());
    std::thread::sleep(Duration::from_millis(500));
    let seq = c.secuencia();
    assert_eq!(seq.last().map(String::as_str), Some("cocido(ok=false,canc=true,cedio=false)"), "{seq:?}");
    assert!(!seq.iter().any(|e| e.starts_with("build(")), "cancelar descarta lo pendiente: {seq:?}");
    assert!(std::fs::read_dir(c.d.path().join("figuras-cache")).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".md5")), "ningún md5 de figuras canceladas");
}

#[test]
fn la_limpieza_borra_los_sellos_viejos_con_vista_previa_y_se_niega_sin_lista_completa_o_con_trabajo_en_curso() {
    let c = caso();
    assert!(c.s.figures_clean_preview().is_err(), "sin listado todavía");
    c.s.request_bake().unwrap();
    c.esperar("la cocción", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    // Quedan de un sello anterior.
    fs::write(c.d.path().join("figuras-cache/AAAAAA-uno-0.pdf"), "viejo").unwrap();
    fs::write(c.d.path().join("figuras-cache/AAAAAA-uno-0.md5"), "viejo").unwrap();
    let p = c.s.figures_clean_preview().unwrap();
    assert_eq!((p.archivos.len(), p.figuras), (2, 1));
    assert!(c.figura("uno-0", "pdf").is_file(), "la vista previa no borra");
    // Con un trabajo en curso se niega.
    c.escribir("demora.txt", "3000");
    c.cambiar_estilo(2);
    c.s.request_bake().unwrap();
    assert!(c.s.figures_clean().is_err(), "ocupado");
    c.s.cancel();
    c.esperar("el final", 30, |c| c.ocioso());
    c.cambiar_estilo(1);
    c.escribir("demora.txt", "50");
    let h = c.s.figures_clean().unwrap();
    assert_eq!(h.archivos.len(), 2, "{h:?}");
    assert!(!c.d.path().join("figuras-cache/AAAAAA-uno-0.pdf").exists());
    assert!(c.figura("dos-1", "pdf").is_file());
}

#[test]
fn la_limpieza_con_el_parcial_activo_no_borra_las_figuras_de_las_partes_que_no_incluye() {
    let c = caso();
    c.s.request_bake().unwrap();
    c.esperar("la cocción de todo", 60, |c| c.ocioso() && c.secuencia().len() == 3);
    // Un cambio de estilo y un build del parcial: la lista que queda es completa y del sello nuevo, no la del parcial.
    c.cambiar_estilo(2);
    c.s.request_build(Some("parcial")).unwrap();
    c.esperar("el ciclo completo", 90, |c| c.ocioso() && c.secuencia().len() >= 10);
    let h = c.s.figures_clean().unwrap();
    assert_eq!(h.figuras, 4, "se van las 4 del sello viejo y se quedan las 4 nuevas (las de Uno y las de Dos): {h:?}");
    assert!(c.figura("dos-0", "pdf").is_file() && c.figura("uno-0", "pdf").is_file());
}

#[test]
fn con_el_cache_apagado_no_hay_coccion() {
    let c = caso();
    let cfg = CONFIG.replace("\"mode\": \"project\"", "\"mode\": \"off\"");
    c.escribir("latexviewer.json", &cfg);
    let r = Recolector::nuevo();
    let latexmk = Builder::con_programa("powershell", args_de(&script(OK)));
    let s = Session::open_with_cocinero(c.d.path(), r.sink.clone(), latexmk, Cocinero::new()).unwrap();
    let e = s.request_bake().unwrap_err().to_string();
    assert!(e.contains("apagado"), "{e}");
}
