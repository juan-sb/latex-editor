//! Spike S2: latencia de SyncTeX, `synctex` CLI contra un parser propio, sobre el PDF del libro completo.
//!
//! Uso: s2-synctex <synctex.gz> <pdf> <consultas.tsv> <salida.json> [otros.synctex.gz ...]
//!   consultas.tsv: líneas `F<TAB>ruta absoluta del .tex<TAB>línea` (forward). Las consultas inverse se
//!   derivan de ellas (centro de la primera caja que devuelve el forward) más 25 puntos al azar.
//!
//! Qué mide: carga del .synctex.gz (gunzip + parseo + índices) y memoria; latencia de cada consulta en
//! proceso (promedio de muchas repeticiones, en µs); latencia de cada llamada al CLI (reloj de pared, incluye
//! lanzar el proceso y que el CLI vuelva a leer todo el archivo); y si los dos dicen lo mismo.

mod synctex;

use std::hint::black_box;
use std::process::Command;
use std::time::Instant;
use synctex::{load, Rect, Synctex};

const REPS: u32 = 300;

fn mb() -> f64 {
    memory_stats::memory_stats().map(|m| m.physical_mem as f64 / 1048576.0).unwrap_or(0.0)
}

fn pct(v: &mut Vec<f64>, p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn resumen(v: &[f64]) -> (f64, f64, f64, f64) {
    let mut x = v.to_vec();
    let media = if x.is_empty() { f64::NAN } else { x.iter().sum::<f64>() / x.len() as f64 };
    (media, pct(&mut x, 0.5), pct(&mut x, 0.95), pct(&mut x, 1.0))
}

fn solo_ascii(s: &str) -> String {
    let base = s.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(s);
    base.chars().filter(|c| c.is_ascii()).collect::<String>().to_lowercase()
}

struct CliView(Vec<Rect>);

fn cli_view(pdf: &str, ruta: &str, linea: u32) -> (f64, CliView) {
    let t = Instant::now();
    let o = Command::new("synctex")
        .args(["view", "-i", &format!("{linea}:0:{ruta}"), "-o", pdf])
        .output()
        .expect("no pude lanzar synctex");
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let txt = String::from_utf8_lossy(&o.stdout).to_string();
    let mut rs: Vec<Rect> = Vec::new();
    let mut cur: Option<Rect> = None;
    for l in txt.lines() {
        let val = |p: &str| l.strip_prefix(p).and_then(|v| v.trim().parse::<f64>().ok());
        if let Some(p) = val("Page:") {
            if let Some(r) = cur.take() {
                rs.push(r);
            }
            cur = Some(Rect { page: p as u32, h: 0.0, v: 0.0, w: 0.0, hh: 0.0, x: 0.0, y: 0.0 });
        } else if let Some(r) = cur.as_mut() {
            if let Some(x) = val("x:") { r.x = x }
            if let Some(x) = val("y:") { r.y = x }
            if let Some(x) = val("h:") { r.h = x }
            if let Some(x) = val("v:") { r.v = x }
            if let Some(x) = val("W:") { r.w = x }
            if let Some(x) = val("H:") { r.hh = x }
        }
    }
    if let Some(r) = cur.take() {
        rs.push(r);
    }
    (ms, CliView(rs))
}

fn cli_edit(pdf: &str, page: u32, x: f64, y: f64) -> (f64, Option<(String, u32)>) {
    let t = Instant::now();
    let o = Command::new("synctex")
        .args(["edit", "-o", &format!("{page}:{x}:{y}:{pdf}")])
        .output()
        .expect("no pude lanzar synctex");
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let txt = String::from_utf8_lossy(&o.stdout).to_string();
    let inp = txt.lines().find_map(|l| l.strip_prefix("Input:")).map(|s| s.trim().to_string());
    let lin = txt.lines().find_map(|l| l.strip_prefix("Line:")).and_then(|s| s.trim().parse::<u32>().ok());
    (ms, inp.zip(lin))
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("uso: s2-synctex <synctex.gz> <pdf> <consultas.tsv> <salida.json> [otros.synctex.gz ...]");
        std::process::exit(2);
    }
    let (gz, pdf, tsv, salida) = (&a[1], &a[2], &a[3], &a[4]);
    let mut json = String::from("{\n");

    // --- carga ------------------------------------------------------------------------------------------------
    let mem0 = mb();
    let mut totales = Vec::new();
    let mut ultimo = None;
    for _ in 0..5 {
        let (sx, st) = load(gz).expect("no pude cargar el synctex");
        totales.push(st.gunzip_ms + st.parse_ms + st.index_ms);
        ultimo = Some((sx, st));
    }
    let (sx, st) = ultimo.unwrap();
    let mem1 = mb();
    totales.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("== carga de {gz}");
    println!(
        "  {} KB gz -> {:.1} MB; {} nodos, {} páginas, {} archivos de entrada",
        st.gz_bytes / 1024,
        st.raw_bytes as f64 / 1048576.0,
        sx.nodes.len(),
        sx.pages,
        sx.inputs.len()
    );
    println!(
        "  gunzip {:.0} ms + parseo {:.0} ms + índices {:.0} ms = {:.0} ms (5 cargas: min {:.0}, mediana {:.0}, max {:.0})",
        st.gunzip_ms, st.parse_ms, st.index_ms, st.gunzip_ms + st.parse_ms + st.index_ms,
        totales[0], totales[2], totales[4]
    );
    println!("  memoria: {:.0} MB antes, {:.0} MB después de cargar", mem0, mem1);
    json += &format!(
        "  \"carga_ms\": {{\"gunzip\": {:.1}, \"parseo\": {:.1}, \"indices\": {:.1}, \"total_min\": {:.1}, \"total_mediana\": {:.1}, \"total_max\": {:.1}}},\n  \"nodos\": {},\n  \"gz_kb\": {},\n  \"raw_mb\": {:.1},\n  \"memoria_mb\": {{\"antes\": {:.0}, \"despues\": {:.0}}},\n",
        st.gunzip_ms, st.parse_ms, st.index_ms, totales[0], totales[2], totales[4], sx.nodes.len(), st.gz_bytes / 1024,
        st.raw_bytes as f64 / 1048576.0, mem0, mem1
    );

    // --- consultas forward -------------------------------------------------------------------------------------------
    let consultas: Vec<(String, u32)> = std::fs::read_to_string(tsv)
        .expect("no pude leer las consultas")
        .lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split('\t').collect();
            (c.len() == 3 && c[0] == "F").then(|| (c[1].to_string(), c[2].parse().unwrap()))
        })
        .collect();

    let mut f_prop_us = Vec::new();
    let mut f_cli_ms = Vec::new();
    let (mut f_sin_tag, mut f_sin_res, mut f_primero_ok, mut f_paginas_ok, mut f_cli_vacio) = (0, 0, 0, 0, 0);
    let mut centros: Vec<(u32, f64, f64)> = Vec::new();
    let mut es_texto: Vec<bool> = Vec::new();
    for (ruta, linea) in &consultas {
        let Some(tag) = sx.tag_de(ruta) else { f_sin_tag += 1; continue };
        let t = Instant::now();
        for _ in 0..REPS {
            black_box(sx.forward(black_box(tag), black_box(*linea)));
        }
        f_prop_us.push(t.elapsed().as_secs_f64() * 1e6 / REPS as f64);
        let (_, mine) = sx.forward(tag, *linea);
        if mine.is_empty() {
            f_sin_res += 1;
        }
        let (ms, cli) = cli_view(pdf, ruta, *linea);
        f_cli_ms.push(ms);
        // Ida y vuelta: el inverse se prueba en el punto "x,y" que devuelve el propio CLI para esa línea.
        if let Some(c) = cli.0.first() {
            centros.push((c.page, c.x, c.y));
            es_texto.push(c.hh < 20.0); // una línea de texto mide ~10 bp de alto; una figura, cientos
        }
        if std::env::var("S2_DEBUG").is_ok() {
            let corto = |r: &Rect| format!("p{} h={:.1} v={:.1} W={:.1} H={:.1}", r.page, r.h, r.v, r.w, r.hh);
            println!("  [dbg] {} : {}", solo_ascii(ruta), linea);
            println!("        CLI : {}", cli.0.iter().map(corto).collect::<Vec<_>>().join(" | "));
            println!("        propio ({} cajas): {}", mine.len(), mine.iter().take(4).map(corto).collect::<Vec<_>>().join(" | "));
        }
        if cli.0.is_empty() {
            f_cli_vacio += 1;
            continue;
        }
        let c0 = cli.0[0];
        if mine.iter().any(|r| r.page == c0.page && (r.h - c0.h).abs() < 2.0 && (r.v - c0.v).abs() < 2.0) {
            f_primero_ok += 1;
        }
        let mut pm: Vec<u32> = mine.iter().map(|r| r.page).collect();
        let mut pc: Vec<u32> = cli.0.iter().map(|r| r.page).collect();
        pm.sort();
        pm.dedup();
        pc.sort();
        pc.dedup();
        if pm == pc {
            f_paginas_ok += 1;
        }
    }
    let n_f = consultas.len() - f_sin_tag;
    let (pm, pp50, pp95, pmax) = resumen(&f_prop_us);
    let (cm, cp50, cp95, cmax) = resumen(&f_cli_ms);
    println!("== forward ({} consultas)", n_f);
    println!("  propio: media {:.1} µs, p50 {:.1}, p95 {:.1}, máx {:.1} µs", pm, pp50, pp95, pmax);
    println!("  CLI:    media {:.0} ms, p50 {:.0}, p95 {:.0}, máx {:.0} ms", cm, cp50, cp95, cmax);
    println!(
        "  acuerdo: primera caja del CLI entre las nuestras {}/{}; mismo conjunto de páginas {}/{}; sin tag {}; sin resultado propio {}; CLI sin resultado {}",
        f_primero_ok, n_f, f_paginas_ok, n_f, f_sin_tag, f_sin_res, f_cli_vacio
    );
    json += &format!(
        "  \"forward\": {{\"n\": {}, \"propio_us\": {{\"media\": {:.1}, \"p50\": {:.1}, \"p95\": {:.1}, \"max\": {:.1}}}, \"cli_ms\": {{\"media\": {:.1}, \"p50\": {:.1}, \"p95\": {:.1}, \"max\": {:.1}}}, \"primera_caja_ok\": {}, \"paginas_ok\": {}, \"sin_resultado_propio\": {}, \"cli_vacio\": {}}},\n",
        n_f, pm, pp50, pp95, pmax, cm, cp50, cp95, cmax, f_primero_ok, f_paginas_ok, f_sin_res, f_cli_vacio
    );

    // --- consultas inverse: centros de lo que devolvió el forward + 25 puntos al azar ---------------------------------
    let mut estado: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut azar = || {
        estado ^= estado << 13;
        estado ^= estado >> 7;
        estado ^= estado << 17;
        (estado >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut puntos = centros.clone();
    let n_centros = puntos.len();
    for _ in 0..25 {
        let pg = 1 + (azar() * sx.pages as f64) as u32;
        puntos.push((pg.min(sx.pages as u32), 90.0 + azar() * 415.0, 100.0 + azar() * 640.0));
    }
    let mut i_prop_us = Vec::new();
    let mut i_cli_ms = Vec::new();
    let (mut i_igual, mut i_dentro1, mut i_dentro5, mut i_sin_prop, mut i_sin_cli, mut i_comp) = (0, 0, 0, 0, 0, 0);
    let (mut c_igual, mut c_comp) = (0, 0);
    let (mut t_igual, mut t_comp, mut t_dentro1) = (0, 0, 0); // ida y vuelta sólo en líneas de texto
    for (k, &(pg, x, y)) in puntos.iter().enumerate() {
        let t = Instant::now();
        for _ in 0..REPS {
            black_box(sx.inverse(black_box(pg), black_box(x), black_box(y)));
        }
        i_prop_us.push(t.elapsed().as_secs_f64() * 1e6 / REPS as f64);
        let mine = sx.inverse(pg, x, y);
        let (ms, cli) = cli_edit(pdf, pg, x, y);
        i_cli_ms.push(ms);
        match (mine, cli) {
            (None, _) => i_sin_prop += 1,
            (_, None) => i_sin_cli += 1,
            (Some((tag, ln, _)), Some((inp, cln))) => {
                let nuestro = sx.inputs.iter().find(|(t, _)| *t == tag).map(|(_, r)| solo_ascii(r)).unwrap_or_default();
                let mismo_archivo = nuestro == solo_ascii(&inp);
                let d = (ln as i64 - cln as i64).abs();
                if std::env::var("S2_DEBUG").is_ok() && !(mismo_archivo && d == 0) {
                    println!("  [inv] p{} x={:.1} y={:.1}: CLI {}:{}  propio {}:{} ({}){}", pg, x, y, solo_ascii(&inp), cln, nuestro, ln,
                        if k < n_centros { "ida y vuelta" } else { "al azar" },
                        if k < 3 { sx.explicar(pg, x, y) } else { String::new() });
                }
                i_comp += 1;
                if mismo_archivo && d == 0 { i_igual += 1 }
                if mismo_archivo && d <= 1 { i_dentro1 += 1 }
                if mismo_archivo && d <= 5 { i_dentro5 += 1 }
                if k < n_centros {
                    c_comp += 1;
                    if mismo_archivo && d == 0 { c_igual += 1 }
                    if es_texto[k] {
                        t_comp += 1;
                        if mismo_archivo && d == 0 { t_igual += 1 }
                        if mismo_archivo && d <= 1 { t_dentro1 += 1 }
                    }
                }
            }
        }
    }
    let (qm, qp50, qp95, qmax) = resumen(&i_prop_us);
    let (dm, dp50, dp95, dmax) = resumen(&i_cli_ms);
    println!("== inverse ({} consultas: {} centros del forward + 25 al azar)", puntos.len(), n_centros);
    println!("  propio: media {:.1} µs, p50 {:.1}, p95 {:.1}, máx {:.1} µs", qm, qp50, qp95, qmax);
    println!("  CLI:    media {:.0} ms, p50 {:.0}, p95 {:.0}, máx {:.0} ms", dm, dp50, dp95, dmax);
    println!(
        "  acuerdo (mismo archivo y línea) {}/{}; a ±1 línea {}/{}; a ±5 {}/{}; sólo los centros del forward: {}/{}; sin resultado propio {}; CLI sin resultado {}",
        i_igual, i_comp, i_dentro1, i_comp, i_dentro5, i_comp, c_igual, c_comp, i_sin_prop, i_sin_cli
    );
    println!(
        "  ida y vuelta sólo en líneas de texto: misma línea {}/{}, a ±1 {}/{}",
        t_igual, t_comp, t_dentro1, t_comp
    );
    json += &format!(
        "  \"inverse\": {{\"n\": {}, \"propio_us\": {{\"media\": {:.1}, \"p50\": {:.1}, \"p95\": {:.1}, \"max\": {:.1}}}, \"cli_ms\": {{\"media\": {:.1}, \"p50\": {:.1}, \"p95\": {:.1}, \"max\": {:.1}}}, \"igual\": {}, \"dentro_1\": {}, \"dentro_5\": {}, \"comparables\": {}, \"centros_igual\": {}, \"centros_comparables\": {}, \"texto_igual\": {}, \"texto_dentro_1\": {}, \"texto_comparables\": {}, \"sin_propio\": {}, \"sin_cli\": {}}}",
        puntos.len(), qm, qp50, qp95, qmax, dm, dp50, dp95, dmax, i_igual, i_dentro1, i_dentro5, i_comp, c_igual, c_comp, t_igual, t_dentro1, t_comp, i_sin_prop, i_sin_cli
    );

    // --- escala: la carga de otros archivos --------------------------------------------------------------------------
    json += ",\n  \"otras_cargas\": [";
    for (k, otro) in a[5..].iter().enumerate() {
        let (s2, t2) = load(otro).expect("no pude cargar");
        let total = t2.gunzip_ms + t2.parse_ms + t2.index_ms;
        println!("== carga de {otro}: {} KB gz, {} nodos, {:.0} ms", t2.gz_bytes / 1024, s2.nodes.len(), total);
        json += &format!("{}{{\"archivo\": {:?}, \"gz_kb\": {}, \"nodos\": {}, \"ms\": {:.1}}}", if k > 0 { ", " } else { "" }, otro, t2.gz_bytes / 1024, s2.nodes.len(), total);
    }
    json += "]\n}\n";
    std::fs::write(salida, json).expect("no pude escribir el json");
    let _: &Synctex = &sx;
}
