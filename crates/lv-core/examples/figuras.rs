//! Estado del cache de figuras de un proyecto y cuánto cuesta decidir si hay que cocinar antes de un build:
//!
//!   cargo run --release -p lv-core --example figuras -- <carpeta> [--root <raíz.tex>]
//!
//! Imprime el sello de hoy, cuántas figuras hay por sello, si el disparo automático cocinaría, y mide (promedio de 200 corridas)
//! el chequeo que hace `request_build` antes de cada build: el sello (md5 de los `stampFiles`), el listado de la carpeta del
//! cache y la regla del 60 %. Criterio de F6: menos de 20 ms para un guardado sin figuras nuevas.

use lv_core::config::read_config;
use lv_core::figcache::{self, FigureCfg};
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(carpeta) = args.first() else {
        eprintln!("uso: figuras <carpeta>");
        std::process::exit(2);
    };
    let root = Path::new(carpeta);
    let cfg = match read_config(root) {
        Ok(Some(c)) => c,
        Ok(None) => {
            eprintln!("la carpeta no tiene latexviewer.json");
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let f = FigureCfg::de(&cfg);
    let chequeo = || {
        let hoy = figcache::sello(root, &f.stamp_files);
        let figs = figcache::escanear(root, &f.dir);
        let estado = figcache::estado_del_cache(&figs, hoy.as_deref());
        (figcache::necesita_cocer(&f, &estado), estado)
    };
    let (cocina, estado) = chequeo();
    println!("modo {:?}, carpeta {:?}, sello {:?}", f.modo, f.dir, estado.sello);
    println!(
        "figuras con PDF: {} del sello de hoy, {} de sellos anteriores, {} sin sello; {:.1} MB en total, {:.1} MB de sellos viejos",
        estado.actuales,
        estado.viejas,
        estado.sin_sello,
        estado.bytes as f64 / 1048576.0,
        estado.bytes_viejos as f64 / 1048576.0
    );
    println!("el disparo automático cocinaría antes del build: {cocina}");
    let n = 200;
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(chequeo());
    }
    println!("chequeo previo al build: {:.2} ms (promedio de {n})", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
}
