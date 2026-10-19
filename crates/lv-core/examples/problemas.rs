//! Imprime los problemas que el parser saca de un log: `cargo run -p lv-core --example problemas -- <raíz> <archivo.log|.blg|.ilg>`.
//! Sirve para mirar un log nuevo antes de escribir su prueba.

use lv_core::logparse::{count, parse_biber_log, parse_makeindex_log, parse_tex_log};
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("uso: problemas <raíz> <log>");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&args[1]).expect("no se pudo leer el log");
    let root = Path::new(&args[0]);
    let t = Instant::now();
    let p = if args[1].ends_with(".blg") {
        parse_biber_log(&bytes, root)
    } else if args[1].ends_with(".ilg") {
        parse_makeindex_log(&bytes, root)
    } else {
        parse_tex_log(&bytes, root)
    };
    let ms = t.elapsed();
    for x in &p {
        println!(
            "{:8} {:20} {}:{}{} | {} | {}",
            format!("{:?}", x.severity),
            x.kind,
            x.file.as_deref().unwrap_or("-"),
            x.line.map_or("-".to_string(), |l| l.to_string()),
            x.line_end.map_or(String::new(), |l| format!("--{l}")),
            x.message.chars().take(110).collect::<String>(),
            x.context.chars().take(60).collect::<String>()
        );
    }
    eprintln!("{:?} en {:?} ({} bytes)", count(&p), ms, bytes.len());
}
