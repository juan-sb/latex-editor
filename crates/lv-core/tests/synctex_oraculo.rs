//! El parser propio de SyncTeX contra el CLI `synctex` como oráculo (6.1 del plan), sobre un PDF compilado de verdad por el
//! motor de la app. Hace falta TeX instalado: `cargo test -p lv-core --features tex`.
//!
//! Se compara línea por línea sobre los párrafos de `fixtures/sync` (líneas largas, como en el libro). Las ecuaciones, las
//! tablas y las notas al pie se miden y se muestran, pero sólo los párrafos de texto tienen que coincidir casi siempre: ahí
//! es donde S2 midió 91 % y donde el criterio de aceptación de F4 lo exige.
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::build::{BuildEvent, Builder};
use lv_core::synctex::Synctex;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("sync")
}

fn compilar() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("pr ñ oyecto");
    fs::create_dir_all(&p).unwrap();
    fs::copy(fixture().join("main.tex"), p.join("main.tex")).unwrap();
    let r = Recolector::nuevo();
    Builder::new().start(&p, "main.tex", "completo", r.sink.clone()).expect("lanzar latexmk");
    match r.esperar(300) {
        BuildEvent::Finished { ok, .. } => assert!(ok, "{}", r.log()),
        _ => unreachable!(),
    }
    (tmp, p)
}

/// `"Page:1\nx:72\ny:100\nh:72\nv:110\nW:456\nH:10\n..."` a la lista de registros del CLI.
fn campos(salida: &str, nombres: &[&str]) -> Vec<Vec<f64>> {
    let mut out = Vec::new();
    let mut actual: Vec<Option<f64>> = vec![None; nombres.len()];
    for l in salida.lines() {
        for (k, n) in nombres.iter().enumerate() {
            if let Some(v) = l.strip_prefix(&format!("{n}:")) {
                if k == 0 && actual.iter().any(Option::is_some) {
                    if actual.iter().all(Option::is_some) {
                        out.push(actual.iter().map(|x| x.unwrap()).collect());
                    }
                    actual = vec![None; nombres.len()];
                }
                actual[k] = v.trim().parse().ok();
            }
        }
    }
    if actual.iter().all(Option::is_some) {
        out.push(actual.iter().map(|x| x.unwrap()).collect());
    }
    out
}

fn cli(args: &[&str]) -> String {
    let o = Command::new("synctex").args(args).output().expect("synctex en el PATH");
    String::from_utf8_lossy(&o.stdout).to_string()
}

#[test]
fn el_parser_coincide_con_el_cli_en_los_parrafos_de_texto() {
    let (_t, p) = compilar();
    let pdf = p.join(".lv/build/completo/lv-completo.pdf");
    let s = Synctex::load(&p.join(".lv/build/completo/lv-completo.synctex.gz")).expect("leer el synctex");
    let tag = s.tag_of(&p, "main.tex").expect("main.tex está entre las entradas");
    assert!(s.rel_of_tag(&p, tag).as_deref() == Some("main.tex"));

    let fuente = fs::read_to_string(p.join("main.tex")).unwrap();
    let (mut total, mut fwd_ok, mut pag_ok, mut inv_ok, mut inv_total) = (0, 0, 0, 0, 0);
    let mut fallas = Vec::new();
    for (i, l) in fuente.lines().enumerate() {
        let n = i as u32 + 1;
        // Párrafos de texto: líneas largas que empiezan con una letra y no son un comando.
        if l.len() < 200 || !l.starts_with(|c: char| c.is_alphabetic()) {
            continue;
        }
        total += 1;
        let abs = p.join("main.tex");
        let v = cli(&["view", "-i", &format!("{n}:1:{}", abs.display()), "-o", &pdf.display().to_string()]);
        let oraculo = campos(&v, &["Page", "h", "v", "W", "H", "x", "y"]);
        let Some(primero) = oraculo.first() else { fallas.push(format!("línea {n}: el CLI no dio nada")); continue };
        let Some(f) = s.forward(tag, n) else { fallas.push(format!("línea {n}: el parser no dio cajas")); continue };
        // Mismo conjunto de páginas, y la primera caja del CLI está entre las propias (±2 bp).
        let pags_cli: std::collections::BTreeSet<u32> = oraculo.iter().map(|r| r[0] as u32).collect();
        let pags_nuestras: std::collections::BTreeSet<u32> = f.rects.iter().map(|r| r.page).collect();
        if pags_cli == pags_nuestras {
            pag_ok += 1;
        }
        let esta = f.rects.iter().any(|r| {
            r.page == primero[0] as u32 && (r.x - primero[1]).abs() < 2.0 && (r.y + r.h - primero[2]).abs() < 2.5 && (r.w - primero[3]).abs() < 2.0
        });
        if esta {
            fwd_ok += 1;
        } else {
            fallas.push(format!("línea {n}: forward {primero:?} contra {:?}", f.rects.first()));
        }
        // Ida y vuelta: el punto que informa el CLI, devuelto al código por los dos.
        for r in oraculo.iter().take(3) {
            inv_total += 1;
            let e = cli(&["edit", "-o", &format!("{}:{}:{}:{}", r[0] as u32, r[5], r[6], pdf.display())]);
            let linea_cli: Option<u32> = e.lines().find_map(|x| x.strip_prefix("Line:")).and_then(|x| x.trim().parse().ok());
            let nuestro = s.inverse(r[0] as u32, r[5], r[6]);
            if linea_cli.is_some() && nuestro.map(|i| i.line) == linea_cli && nuestro.and_then(|i| s.rel_of_tag(&p, i.tag)).as_deref() == Some("main.tex") {
                inv_ok += 1;
            } else {
                fallas.push(format!("línea {n}: inverse del punto ({}, {}) en la página {}: CLI {linea_cli:?} contra {:?}", r[5], r[6], r[0], nuestro.map(|i| i.line)));
            }
        }
    }
    eprintln!("párrafos {total}: forward {fwd_ok}/{total}, mismas páginas {pag_ok}/{total}, inverse {inv_ok}/{inv_total}");
    for f in fallas.iter().take(12) {
        eprintln!("  {f}");
    }
    assert!(total >= 9, "el fixture tiene que tener al menos 9 párrafos largos ({total})");
    assert!(fwd_ok * 10 >= total * 9, "forward: {fwd_ok}/{total}\n{}", fallas.join("\n"));
    assert!(pag_ok * 10 >= total * 9, "páginas: {pag_ok}/{total}");
    assert!(inv_ok * 10 >= inv_total * 9, "inverse: {inv_ok}/{inv_total}\n{}", fallas.join("\n"));
}

#[test]
fn las_lineas_que_no_son_texto_se_resuelven_sin_romper_y_se_miden() {
    // Ecuación, tabla, nota al pie, lista: no se exige igualdad con el CLI (S2: el criterio de qué hijo elegir difiere),
    // sólo que el parser conteste algo razonable (alguna caja en una página que existe) y que se pueda medir el acuerdo.
    let (_t, p) = compilar();
    let pdf = p.join(".lv/build/completo/lv-completo.pdf");
    let s = Synctex::load(&p.join(".lv/build/completo/lv-completo.synctex.gz")).unwrap();
    let tag = s.tag_of(&p, "main.tex").unwrap();
    let fuente = fs::read_to_string(p.join("main.tex")).unwrap();
    let (mut raras, mut acuerdo) = (0, 0);
    for (i, l) in fuente.lines().enumerate() {
        let n = i as u32 + 1;
        let especial = l.contains("\\item") || l.contains("\\footnote") || l.contains("\\begin{equation}") || l.contains("Butterworth & ninguna") || l.contains("1+\\left");
        if !especial {
            continue;
        }
        raras += 1;
        let f = s.forward(tag, n).unwrap_or_else(|| panic!("la línea {n} ({l:?}) no dio cajas"));
        assert!(f.rects.iter().all(|r| (r.page as usize) <= s.pages() && r.w > 0.0 && r.h > 0.0), "{f:?}");
        let v = cli(&["view", "-i", &format!("{n}:1:{}", p.join("main.tex").display()), "-o", &pdf.display().to_string()]);
        if let Some(c) = campos(&v, &["Page", "h", "v", "W", "H"]).first() {
            if f.rects.iter().any(|r| r.page == c[0] as u32 && (r.x - c[1]).abs() < 3.0 && (r.y + r.h - c[2]).abs() < 3.0) {
                acuerdo += 1;
            }
        }
    }
    eprintln!("líneas especiales {raras}: coinciden con el CLI en la primera caja {acuerdo}/{raras}");
    assert!(raras >= 5);
}
