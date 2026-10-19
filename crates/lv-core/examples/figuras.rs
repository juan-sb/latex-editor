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

    // Lo que cuesta saltear el listado de un perfil que sólo consume el cache: el grafo del proyecto, la huella de las figuras
    // (lee los `.tex` alcanzados) y el chequeo de los PDF de la figlist (`Session::cache_al_dia`).
    let sello = figcache::sello(root, &f.stamp_files).unwrap_or_default();
    let lista = figcache::leer_figlist(root);
    // Los archivos que las figuras leen desde adentro de su `tikzpicture` (`\input{datos}`, imágenes, `plot file`): cuando cambia alguno,
    // las figuras de quien lo incluye se recocinan.
    {
        let ix = lv_core::graph::ProjectIndex::build(root, &cfg.root, &cfg.parts.commands);
        println!("archivos que se leen desde adentro de un tikzpicture: {} ({} dentro de un figure)", ix.datos_de_tikz.len(), ix.datos_de_figuras(true).count());
        for d in &ix.datos_de_tikz {
            println!("  {}:{} lee {}{}", d.incluye, d.line, d.dato, if d.en_figure { "" } else { "  (fuera de un figure: no se externaliza)" });
        }
    }
    let m = 50;
    let t = Instant::now();
    let mut huella = String::new();
    let mut archivos = 0;
    for _ in 0..m {
        let ix = lv_core::graph::ProjectIndex::build(root, &cfg.root, &cfg.parts.commands);
        huella = figcache::huella_de_figuras(root, &ix.reachable, &ix.archivos_de_datos(f.only_in_figure_env), &|rel| ix.part_of(rel).is_some(), &sello);
        archivos = ix.reachable.len();
        if let Some(l) = &lista {
            std::hint::black_box(l.nombres.iter().all(|n| root.join(format!("{n}.pdf")).is_file()));
        }
    }
    println!(
        "saltear el listado (grafo + huella de figuras + PDF de la figlist): {:.2} ms (promedio de {m}; {archivos} archivos alcanzados; huella {huella}; guardada {:?})",
        t.elapsed().as_secs_f64() * 1000.0 / m as f64,
        lista.and_then(|l| l.huella)
    );
}
