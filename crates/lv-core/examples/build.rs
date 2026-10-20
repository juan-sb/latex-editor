//! Compila un proyecto sin interfaz, con el mismo motor que la app (perfiles, partes, sembrado, reparación, cocción de figuras):
//!
//!   cargo run -p lv-core --example build -- <carpeta> [perfil] [--root <raíz.tex>] [--parts "A,B"] [--figuras | --limpiar | --exportar "A,B"|todas | --fragmento <archivo.tex>]
//!
//! Sin `--root` usa la de `latexviewer.json`; sin perfil, el activo (o `completo`). Imprime el log
//! crudo tal como llega y sale con 0 si el build fue ok. Con `--figuras` no compila: cocina las figuras del documento entero
//! (el botón Cocinar del panel Figuras) y sale con 0 si todas salieron bien. En los dos casos espera a que la sesión quede
//! ociosa, así que incluye lo que la cola deja después (la cocción del resto tras un build). Sirve para probar el motor solo
//! y para medir.

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
    let exportar = tomar("--exportar");
    let fragmento = tomar("--fragmento");
    let figuras = args.iter().position(|a| a == "--figuras").map(|i| args.remove(i)).is_some();
    let limpiar = args.iter().position(|a| a == "--limpiar").map(|i| args.remove(i)).is_some();
    if args.is_empty() || args.len() > 2 {
        eprintln!("uso: build <carpeta> [perfil] [--root <raíz.tex>] [--parts \"A,B\"] [--figuras | --limpiar | --exportar \"A,B\"|todas | --fragmento <archivo.tex>]");
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
        BuildEvent::Pass { n, tool, .. } => eprintln!("   [{tool} {n}]"),
        BuildEvent::Figure { n, name, .. } => eprintln!("   [pgf lanzó la figura {n}: {name}]"),
        BuildEvent::Queued { perfil } => eprintln!("== en cola: {perfil}"),
        BuildEvent::Error { message } => eprintln!("== error: {message}"),
        BuildEvent::BakeQueued => eprintln!("== cocción de figuras en cola"),
        BuildEvent::BakeListing { fase, .. } => eprintln!("== listando las figuras ({fase})"),
        BuildEvent::BakeStarted { fase, total, listed, listing_ms, .. } => eprintln!("== cocinando ({fase}): {total} de {listed} (listado en {:.1} s)", listing_ms as f64 / 1000.0),
        BuildEvent::BakeProgress { done, total, name, ok, .. } => eprintln!("   {done}/{total} {name}{}", if ok { "" } else { "  FALLÓ" }),
        BuildEvent::ExportQueued => eprintln!("== exportación en cola"),
        BuildEvent::ExportStarted { total, .. } => eprintln!("== exportando {total} parte(s)"),
        BuildEvent::ExportProgress { done, total, part, num, file, ok, .. } => {
            eprintln!("   {done}/{total} {part} (n.º {}) -> {}{}", num.unwrap_or_else(|| "?".into()), file.unwrap_or_else(|| "-".into()), if ok { "" } else { "  FALLÓ" })
        }
        fin @ (BuildEvent::Finished { .. } | BuildEvent::BakeFinished { .. } | BuildEvent::ExportFinished { .. }) => {
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
    if limpiar {
        // La limpieza del panel Figuras: borra del cache lo que el último listado completo no nombra.
        match sesion.figures_clean_preview().and_then(|p| sesion.figures_clean().map(|h| (p, h))) {
            Ok((p, h)) => {
                eprintln!("== limpieza: {} archivos de {} figuras, {:.1} MB (borrados: {}, {:.1} MB)", p.archivos.len(), p.figuras, p.bytes as f64 / 1048576.0, h.archivos.len(), h.bytes as f64 / 1048576.0);
                return;
            }
            Err(e) => {
                eprintln!("no se pudo limpiar: {e}");
                std::process::exit(1);
            }
        }
    }
    let ok = (|| -> lv_core::error::Result<()> {
        if let Some(r) = &root {
            sesion.set_root(r)?;
        }
        if let Some(p) = &parts {
            sesion.set_state(StatePatch { selection: Some(p.split(',').map(|s| s.trim().to_string()).collect()), ..Default::default() })?;
        }
        if let Some(e) = &exportar {
            let partes = if e == "todas" { None } else { Some(e.split(',').map(|s| s.trim().to_string()).collect()) };
            sesion.request_export(partes).map(|_| ())
        } else if let Some(f) = &fragmento {
            let texto = std::fs::read_to_string(f).map_err(|e| lv_core::error::Error::Io(format!("{f}: {e}")))?;
            sesion.request_fragment(texto).map(|_| ())
        } else if figuras {
            sesion.request_bake().map(|_| ())
        } else {
            sesion.request_build(args.get(1).map(String::as_str)).map(|_| ())
        }
    })();
    if let Err(e) = ok {
        eprintln!("no se pudo lanzar: {e}");
        std::process::exit(2);
    }
    let mut salida = 0;
    // El primer aviso de lo pedido (un build o una cocción) fija el código de salida; después se espera a que la cola se vacíe.
    let esperado = |ev: &BuildEvent| {
        matches!(
            (figuras, exportar.is_some(), ev),
            (false, false, BuildEvent::Finished { .. }) | (true, false, BuildEvent::BakeFinished { .. }) | (false, true, BuildEvent::ExportFinished { .. })
        )
    };
    loop {
        let ev = match rx.recv_timeout(std::time::Duration::from_millis(400)) {
            Ok(ev) => ev,
            // Un trabajo que termina deja la sesión libre (o ya reservada para el siguiente) antes de avisar: sin nada corriendo, se sale.
            Err(mpsc::RecvTimeoutError::Timeout) if sesion.is_building() => continue,
            Err(_) => break,
        };
        match &ev {
            BuildEvent::Finished { perfil, ok, code, ms, pdf, updated, passes, repaired, errors, .. } => {
                eprintln!(
                    "== terminó {perfil}: ok={ok} código={code:?} {:.1} s pasadas={passes} pdf={pdf:?} actualizado={updated} reparado={repaired} errores={errors}",
                    *ms as f64 / 1000.0
                );
                if esperado(&ev) {
                    salida = if *ok { 0 } else { 1 };
                }
            }
            BuildEvent::BakeFinished { ok, cancelled, ceded, cooked, failed, remaining, ms, error, .. } => {
                eprintln!(
                    "== cocción terminada: ok={ok} cocidas={cooked} fallidas={failed} pendientes={remaining} cancelada={cancelled} cedió={ceded} {:.1} s{}",
                    *ms as f64 / 1000.0,
                    error.as_ref().map(|e| format!(" error: {e}")).unwrap_or_default()
                );
                if esperado(&ev) {
                    salida = if *ok { 0 } else { 1 };
                }
            }
            BuildEvent::ExportFinished { ok, cancelled, exported, failed, ms, dir, error, .. } => {
                eprintln!(
                    "== exportación terminada: ok={ok} exportadas={exported} fallidas={failed} cancelada={cancelled} {:.1} s en {dir}{}",
                    *ms as f64 / 1000.0,
                    error.as_ref().map(|e| format!(" error: {e}")).unwrap_or_default()
                );
                if esperado(&ev) {
                    salida = if *ok { 0 } else { 1 };
                }
            }
            _ => {}
        }
    }
    std::process::exit(salida);
}
