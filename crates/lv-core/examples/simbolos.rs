//! Cuenta lo que el índice de símbolos saca de un proyecto y cuánto tarda: `cargo run --release -p lv-core --example simbolos --
//! <carpeta> [--root <raíz.tex>]`. Sin `--root` usa la de `latexviewer.json` o la que se infiera. Sirve para medir y para mirar el lint.

use lv_core::config::read_config;
use lv_core::graph::ProjectIndex;
use lv_core::symbols::Symbols;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(carpeta) = args.first() else {
        eprintln!("uso: simbolos <carpeta> [--root <raíz.tex>]");
        std::process::exit(2);
    };
    let root = Path::new(carpeta);
    let cfg = read_config(root).ok().flatten();
    let raiz = args.iter().position(|a| a == "--root").and_then(|i| args.get(i + 1).cloned()).or_else(|| cfg.as_ref().map(|c| c.root.clone())).unwrap_or_else(|| "main.tex".into());
    let comandos = cfg.map(|c| c.parts.commands).unwrap_or_else(|| vec!["include".into()]);
    let t0 = Instant::now();
    let ix = ProjectIndex::build(root, &raiz, &comandos);
    let t_grafo = t0.elapsed();
    let t1 = Instant::now();
    let s = Symbols::build(root, &ix);
    let t_simbolos = t1.elapsed();
    println!(
        "grafo {:?} ({} .tex), símbolos {:?}: {} etiquetas, {} \\ref, {} citas, {} entradas de .bib, {} secciones, {} definiciones, {} archivos, {} problemas de lint",
        t_grafo, ix.reachable.len(), t_simbolos, s.labels.len(), s.refs.len(), s.cites.len(), s.bib.len(), s.sections.len(), s.defs.len(), s.files.len(), s.lint.len()
    );
    // `--search <texto>` mide también la búsqueda en el proyecto (literal y, con `--regex`, como expresión regular).
    if let Some(q) = args.iter().position(|a| a == "--search").and_then(|i| args.get(i + 1)) {
        let regex = args.iter().any(|a| a == "--regex");
        for todo in [false, true] {
            let opciones = lv_core::search::SearchOptions { query: q.clone(), regex, case_sensitive: false, whole_word: false, all_files: todo };
            let t = Instant::now();
            match lv_core::search::search(root, &ix, &opciones, None) {
                Ok(r) => println!("búsqueda de «{q}» ({}): {} coincidencias en {} archivos, {} leídos, {:?} ({} ms según el core)", if todo { "todo el árbol" } else { "archivos del grafo" }, r.total, r.files.len(), r.files_scanned, t.elapsed(), r.ms),
                Err(e) => println!("búsqueda: {e}"),
            }
        }
    }
    for p in s.lint.iter().take(15) {
        println!("  {:?} {} {}:{} {}", p.severity, p.kind, p.file.as_deref().unwrap_or("-"), p.line.unwrap_or(0), p.message);
    }
}
