//! Compila un proyecto sin interfaz, con el mismo motor que la app (perfiles, partes, sembrado, reparación):
//!
//!   cargo run -p lv-core --example build -- <carpeta> [perfil] [--root <raíz.tex>] [--parts "A,B"]
//!
//! Sin `--root` usa la de `latexviewer.json` o `.lv/state.json`; sin perfil, el activo (o `completo`). Imprime el log
//! crudo tal como llega y sale con 0 si el build fue ok. Sirve para probar el motor solo y para medir.

use lv_core::build::BuildEvent;
use lv_core::config::StatePatch;
use lv_core::session::Session;
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut tomar = |nombre: &str| -> Option<String> {
        let i = args.iter().position(|a| a == nombre)?;
        let v = args.get(i + 1)?.clone();
        args.drain(i..=i + 1);
        Some(v)
    };
    let root = tomar("--root");
    let parts = tomar("--parts");
    if args.is_empty() || args.len() > 2 {
        eprintln!("uso: build <carpeta> [perfil] [--root <raíz.tex>] [--parts \"A,B\"]");
        std::process::exit(2);
    }
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: lv_core::build::Sink = Arc::new(move |ev| match ev {
        BuildEvent::Started { cmdline, retry, .. } => eprintln!("== {}{cmdline}", if retry { "(reintento) " } else { "" }),
        BuildEvent::Log { text, .. } => {
            let mut o = std::io::stdout();
            let _ = o.write_all(text.as_bytes());
            let _ = o.flush();
        }
        BuildEvent::Queued { perfil } => eprintln!("== en cola: {perfil}"),
        BuildEvent::Error { message } => eprintln!("== error: {message}"),
        fin @ BuildEvent::Finished { .. } => {
            let _ = tx.lock().unwrap().send(fin);
        }
    });
    let sesion = match Session::open(Path::new(&args[0]), sink) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("no se pudo abrir: {e}");
            std::process::exit(2);
        }
    };
    let ok = (|| -> lv_core::error::Result<()> {
        if let Some(r) = &root {
            sesion.set_root(r)?;
        }
        if let Some(p) = &parts {
            sesion.set_state(StatePatch { selection: Some(p.split(',').map(|s| s.trim().to_string()).collect()), ..Default::default() })?;
        }
        sesion.request_build(args.get(1).map(String::as_str)).map(|_| ())
    })();
    if let Err(e) = ok {
        eprintln!("no se pudo lanzar: {e}");
        std::process::exit(2);
    }
    match rx.recv().unwrap() {
        BuildEvent::Finished { perfil, ok, code, ms, pdf, updated, passes, repaired, .. } => {
            eprintln!(
                "== terminó {perfil}: ok={ok} código={code:?} {:.1} s pasadas={passes} pdf={pdf:?} actualizado={updated} reparado={repaired}",
                ms as f64 / 1000.0
            );
            std::process::exit(if ok { 0 } else { 1 });
        }
        _ => unreachable!(),
    }
}
