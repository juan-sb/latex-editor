//! Lo que la pantalla «Proyecto» propone para una carpeta, sin interfaz:
//!
//!   cargo run -p lv-core --example detectar -- <carpeta> [--root <raíz.tex>] [--json]
//!
//! Imprime las raíces candidatas con su motivo, las partes, los flags, las figuras, los perfiles, las salidas y las variables, y el
//! `latexviewer.json` propuesto (o sólo ese JSON con `--json`). No escribe nada en la carpeta. Sirve para revisar una detección antes de
//! escribir su prueba y para medir cuánto tarda (en el libro, unos 100 ms).

use lv_core::detectar::detectar;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let solo_json = args.iter().position(|a| a == "--json").map(|i| args.remove(i)).is_some();
    let raiz = args.iter().position(|a| a == "--root").and_then(|i| {
        let v = args.get(i + 1).cloned();
        args.drain(i..=i + 1);
        v
    });
    let Some(carpeta) = args.first() else {
        eprintln!("uso: detectar <carpeta> [--root <raíz.tex>] [--json]");
        std::process::exit(2);
    };
    let t = Instant::now();
    let p = match detectar(Path::new(carpeta), raiz.as_deref(), None, &BTreeMap::new()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("no se pudo proponer: {e}");
            std::process::exit(1);
        }
    };
    let ms = t.elapsed().as_millis();
    let json = p.texto.trim_end().to_string();
    if solo_json {
        println!("{json}");
        return;
    }
    println!("Detectado en {ms} ms\n");
    println!("Documento principal: {}", p.raiz);
    for c in &p.candidatas {
        println!("  {} {:?}{}: {}", if c.recomendada { "*" } else { " " }, c.rol, format!(" {}", c.archivo), c.motivo);
    }
    println!("\nPartes ({}): {}", p.partes.len(), p.partes.join(", "));
    println!("Comandos de parte: {}", p.parts_commands.join(", "));
    println!("\nFlags:");
    for f in &p.flags {
        println!("  \\{} -> {:?}  envuelve [{}]  en {}", f.nombre, f.uso, f.envuelve.join(", "), f.archivos.join(", "));
    }
    println!("\nFiguras: modo {} dir {} sello {:?}\n  {}", p.figuras.modo, p.figuras.dir, p.figuras.stamp_files, p.figuras.motivo);
    for a in &p.avisos {
        println!("  aviso: {a}");
    }
    println!("\nPerfiles:");
    for x in &p.perfiles {
        println!("  {} «{}»: {} (publica: {:?})", x.id, x.label, x.uso, x.publica);
    }
    println!("\nSalidas: publicar {:?}, exportar {:?}, ejemplo {:?}", p.salidas.publicar, p.salidas.exportar, p.salidas.ejemplo_nombre);
    println!("\nVariables:");
    for v in &p.variables {
        println!("  {} «{}» {:?} por omisión {:?}\n    {}", v.nombre, v.label, v.choices, v.default, v.frase);
    }
    println!("\n{json}");
}
