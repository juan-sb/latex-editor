//! El sembrado de último recurso con TeX de verdad (`cargo test -p lv-core --features tex`, desde PowerShell).
//!
//! El caso de la paridad de F9: un parcial en frío, sin ningún `.aux` de las otras partes (no hay un build del rápido ni del completo
//! para sembrar), numeraba el capítulo 8 y no 15. Después de una cocción, la cocina compiló el documento entero y tiene el `.aux` de
//! cada parte: de ahí se siembra, y el capítulo sale con su número de verdad. Acá, un libro de dos capítulos con
//! `\setcounter{chapter}{7}`: el segundo es el 9.
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::config::StatePatch;
use lv_core::session::Session;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const CONFIG: &str = r#"{
  "root": "main.tex",
  "parts": { "commands": ["include"] },
  "figureCache": { "mode": "app", "dir": "figuras-cache", "stampFiles": ["estilo.tex"], "onlyInFigureEnv": true, "parallelJobs": 2 },
  "profiles": {
    "parcial": { "partial": true, "externalize": true, "parts": "selection", "label": "Partes elegidas" }
  }
}"#;

const MAIN: &str = "\\documentclass[11pt]{report}
\\usepackage[utf8]{inputenc}
\\usepackage{tikz}
\\input{estilo}
\\begin{document}
\\setcounter{chapter}{7}
\\include{Cap/a}
\\include{Cap/b}
\\end{document}
";

const CAP_A: &str = "\\chapter{Uno}\\label{cap:uno}

Un capítulo con una figura.

\\begin{figure}[ht]
  \\centering
  \\begin{tikzpicture}
    \\draw[miestilo] (0,0) circle (1);
  \\end{tikzpicture}
  \\caption{Un círculo.}
\\end{figure}
";

const CAP_B: &str = "\\chapter{Dos}\\label{cap:dos}

El segundo capítulo, que cita al primero: \\ref{cap:uno}.
";

fn proyecto() -> (TempDir, PathBuf) {
    let t = TempDir::new().unwrap();
    let p = t.path().join("libro");
    for (rel, texto) in [
        ("main.tex", MAIN),
        ("Cap/a.tex", CAP_A),
        ("Cap/b.tex", CAP_B),
        ("estilo.tex", "\\tikzset{miestilo/.style={thick,blue!60!black}}\n"),
        ("latexviewer.json", CONFIG),
    ] {
        let f = p.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, texto).unwrap();
    }
    (t, p)
}

fn esperar_ocioso(s: &Session) {
    let t = Instant::now();
    std::thread::sleep(Duration::from_millis(300));
    while s.is_building() {
        assert!(t.elapsed() < Duration::from_secs(280), "no terminó");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn un_parcial_despues_de_una_coccion_numera_el_capitulo_como_el_libro_aunque_no_haya_otro_build() {
    let (_t, p) = proyecto();
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();

    // Una cocción de todo el documento: lista las figuras y las cocina. Ningún perfil compiló nunca.
    s.request_bake().unwrap();
    esperar_ocioso(&s);
    assert!(!p.join(".lv/build/rapido").exists() && !p.join(".lv/build/completo").exists());
    let aux_a = fs::read_to_string(p.join(".lv/build/cocina/Cap/a.aux")).expect("la cocina compiló la parte A entera");
    assert!(aux_a.contains("setcounter{chapter}{8}"), "{aux_a}");
    assert!(!p.join(".lv/build/cocina/.sospechoso").exists(), "el listado salió bien");

    // Un parcial con sólo la parte B: el capítulo sale 9, no 8.
    s.set_state(StatePatch { selection: Some(vec!["Cap/b".into()]), ..Default::default() }).unwrap();
    s.request_build(Some("parcial")).unwrap();
    esperar_ocioso(&s);
    assert!(r.log().contains("Output written"), "el parcial no compiló: {}", r.log());
    // El `.aux` de la parte que sí se compiló lleva el contador del capítulo: es el que se imprime en el PDF.
    let aux_b = fs::read_to_string(p.join(".lv/build/parcial/Cap/b.aux")).unwrap();
    assert!(aux_b.contains("setcounter{chapter}{9}"), "el capítulo Dos tenía que salir 9: {aux_b}");
    let sembrado = fs::read_to_string(p.join(".lv/build/parcial/Cap/a.aux")).expect("se sembró el .aux de la parte excluida");
    assert_eq!(sembrado, aux_a, "es el de la cocina, tal cual");
}

#[test]
fn sin_cocina_ni_otro_build_el_parcial_numera_como_siempre_y_no_inventa_nada() {
    let (_t, p) = proyecto();
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();
    s.set_state(StatePatch { selection: Some(vec!["Cap/b".into()]), ..Default::default() }).unwrap();
    s.request_build(Some("parcial")).unwrap();
    esperar_ocioso(&s);
    // Esta primera vez la app lista las figuras del parcial antes de compilar (sólo de la parte B): no hay `.aux` de la A en ningún lado.
    assert!(!p.join(".lv/build/parcial/Cap/a.aux").exists(), "no hay de dónde sembrar");
    let aux_b = fs::read_to_string(p.join(".lv/build/parcial/Cap/b.aux")).unwrap();
    assert!(aux_b.contains("setcounter{chapter}{8}"), "sin el .aux de la parte A el capítulo B es el 8: {aux_b}");
}
