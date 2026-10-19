//! Compila un proyecto con el perfil completo, sin interfaz: `cargo run -p lv-core --example build -- <carpeta> <raíz.tex>`.
//! Imprime el log crudo tal como llega y sale con 0 si el build fue ok. Sirve para probar el motor solo y para medir.

use lv_core::build::{BuildEvent, Builder};
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("uso: build <carpeta del proyecto> <raíz.tex relativa a la carpeta>");
        std::process::exit(2);
    }
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: lv_core::build::Sink = Arc::new(move |ev| match ev {
        BuildEvent::Started { cmdline, .. } => eprintln!("== {cmdline}"),
        BuildEvent::Log { text, .. } => {
            let mut o = std::io::stdout();
            let _ = o.write_all(text.as_bytes());
            let _ = o.flush();
        }
        fin @ BuildEvent::Finished { .. } => {
            let _ = tx.lock().unwrap().send(fin);
        }
    });
    let b = Builder::new();
    if let Err(e) = b.start(Path::new(&args[1]), &args[2], "completo", sink) {
        eprintln!("no se pudo lanzar: {e}");
        std::process::exit(2);
    }
    match rx.recv().unwrap() {
        BuildEvent::Finished { ok, code, ms, pdf, updated, .. } => {
            eprintln!("== terminó: ok={ok} código={code:?} {:.1} s pdf={pdf:?} actualizado={updated}", ms as f64 / 1000.0);
            std::process::exit(if ok { 0 } else { 1 });
        }
        _ => unreachable!(),
    }
}
