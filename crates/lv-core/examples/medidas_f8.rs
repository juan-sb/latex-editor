//! Lo que F8 le suma a la app, medido: tomar el candado, buscar procesos de TeX huérfanos, escribir una línea del historial, leer el
//! historial para el panel y correr el doctor. `cargo run --release -p lv-core --example medidas_f8 [-- <carpeta de un proyecto>]`
//! (sin carpeta usa una vacía del temporal; con una carpeta mide también el doctor de ese proyecto, que lanza TeX de verdad).

use lv_core::candado::{self, Adquirido};
use lv_core::historial::{self, Entrada, Herramienta};
use lv_core::{procesos, session::Session};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn mediana(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn medir<T>(n: usize, mut f: impl FnMut() -> T) -> Duration {
    mediana((0..n).map(|_| {
        let t = Instant::now();
        let _ = std::hint::black_box(f());
        t.elapsed()
    }).collect())
}

fn main() {
    let propia = std::env::args().nth(1).map(PathBuf::from);
    let tmp = tempfile::tempdir().expect("carpeta temporal");
    let raiz = propia.clone().unwrap_or_else(|| tmp.path().to_path_buf());
    // El candado, sobre una carpeta aparte para no tocar el `.lv/lock` del proyecto que se mide.
    let sola = tempfile::tempdir().expect("carpeta temporal");
    let adquirir = medir(100, || match candado::adquirir(sola.path()) {
        Adquirido::Tomado(c) => drop(c),
        Adquirido::Ocupado(_) => unreachable!("la carpeta es nueva"),
    });
    println!("candado: tomar y soltar (mediana de 100): {adquirir:?}");

    let huerfanos = medir(20, || procesos::de_tex_en(&raiz));
    println!("procesos de TeX del proyecto (mediana de 20): {huerfanos:?}");
    let todos = medir(20, procesos::cuantos_de_tex);
    println!("cuántos procesos de TeX hay en la máquina (mediana de 20): {todos:?}");

    // El historial: escribir una línea típica de build y leer lo que lee el panel, con el archivo en su tamaño máximo (~1 MB).
    let hist = tempfile::tempdir().expect("carpeta temporal");
    let linea = Entrada {
        inicio_ms: 1,
        tipo: "build".into(),
        perfil: Some("parcial".into()),
        motivo: "guardado: Secciones/Desnormalización.tex".into(),
        ms: 5000,
        ok: true,
        pasadas: 2,
        herramientas: vec![Herramienta { nombre: "pdflatex".into(), ms: 4000 }, Herramienta { nombre: "biber".into(), ms: 600 }],
        figuras_en_el_build: vec!["AB-cauer-3".into(), "AB-cauer-4".into()],
        ..Default::default()
    };
    let escribir = medir(200, || historial::registrar(hist.path(), &linea));
    println!("historial: escribir una línea (mediana de 200): {escribir:?}");
    while std::fs::metadata(hist.path().join(historial::HISTORY_FILE)).map(|m| m.len()).unwrap_or(0) < historial::LIMITE_DE_BYTES - 20_000 {
        historial::registrar(hist.path(), &linea);
    }
    let tamano = std::fs::metadata(hist.path().join(historial::HISTORY_FILE)).map(|m| m.len()).unwrap_or(0);
    let leer = medir(20, || historial::leer(hist.path(), 200).into_iter().map(historial::con_pistas).count());
    println!("historial: leer las últimas 200 con pistas, archivo de {tamano} bytes (mediana de 20): {leer:?}");
    let rotar = {
        let t = Instant::now();
        for _ in 0..200 {
            historial::registrar(hist.path(), &linea);
        }
        t.elapsed() / 200
    };
    println!("historial: escribir cruzando el límite de 1 MB (media de 200, con una rotación adentro): {rotar:?}");

    if propia.is_some() {
        let s = Session::open(&raiz, Arc::new(|_| {})).expect("abrir el proyecto");
        let t = Instant::now();
        let i = s.doctor().expect("doctor");
        println!("doctor de {}: {:?} ({} hallazgos, distribución {:?})", raiz.display(), t.elapsed(), i.hallazgos.len(), i.distribucion);
        for h in &i.hallazgos {
            println!("  {:?} {}: {}", h.nivel, h.id, h.titulo);
        }
    }
}
