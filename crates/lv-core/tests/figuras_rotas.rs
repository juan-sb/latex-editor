//! Figuras que fallan o se cortan (revisión previa a F6, hallazgo 1), con TeX de verdad: `cargo test -p lv-core --features tex`.
//!
//! pgf escribe el `.md5` nuevo de una figura **antes** de lanzar su subcompilación. Si la subcompilación falla, queda el `.md5`
//! nuevo junto al PDF viejo y pgf da la figura por al día: el build sale con código 0, sin errores en el log principal y con
//! la imagen anterior, y el siguiente build ni lo intenta. Este test se escribió antes del arreglo y falló contra el código de
//! F5 en el primer `assert` de abajo (ver `docs/benchmarks.md`, F6); ahora fija lo que la app hace: borrar el PDF y el `.md5`
//! de la figura que no salió, informar el error de su `.log` y reintentar en el build siguiente.
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::build::BuildEvent;
use lv_core::session::Session;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const CONFIG: &str = r#"{
  "root": "main.tex",
  "flags": { "externalize": ["LvExternalize"] },
  "figureCache": { "mode": "project", "dir": "figuras-cache" },
  "profiles": { "figs": { "externalize": true, "parts": "all", "label": "Con figuras" } }
}"#;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("tikz-figuras")
}

/// El fixture sin lo que dejó una compilación anterior, con el `latexviewer.json` de esta prueba.
fn proyecto() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("figuras");
    fs::create_dir_all(&p).unwrap();
    fs::copy(fixture().join("main.tex"), p.join("main.tex")).unwrap();
    fs::write(p.join("latexviewer.json"), CONFIG).unwrap();
    (tmp, p)
}

fn compilar(s: &std::sync::Arc<Session>, r: &Recolector, n: usize) -> (bool, Option<i32>) {
    s.request_build(Some("figs")).unwrap();
    let t = std::time::Instant::now();
    loop {
        let fin: Vec<_> = r.eventos.lock().unwrap().iter().filter_map(|e| if let BuildEvent::Finished { ok, code, .. } = e { Some((*ok, *code)) } else { None }).collect();
        if fin.len() >= n {
            return fin[n - 1];
        }
        assert!(t.elapsed().as_secs() < 240, "el build {n} no terminó");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn figura(p: &Path, n: u32, ext: &str) -> PathBuf {
    p.join(format!("figuras-cache/lv-figs-figure{n}.{ext}"))
}

/// Cuántas subcompilaciones de figuras lanzó pgf en lo que va del log del build.
fn invocaciones(r: &Recolector) -> usize {
    r.log().matches("-jobname \"figuras-cache/").count()
}

#[test]
fn una_figura_que_no_compila_no_queda_dada_por_buena_y_el_build_siguiente_la_reintenta() {
    let (_t, p) = proyecto();
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();

    // 1. En frío: las dos figuras se cocinan.
    let (ok, code) = compilar(&s, &r, 1);
    assert!(ok, "el primer build tiene que salir bien (código {code:?})\n{}", r.log());
    let buena0 = fs::read(figura(&p, 0, "pdf")).expect("la figura 0 se cocinó");
    assert!(figura(&p, 1, "pdf").is_file());
    let inv1 = invocaciones(&r);
    assert_eq!(inv1, 2, "dos figuras, dos subcompilaciones");

    // 2. Se rompe el código de la primera figura.
    let fuente = fs::read_to_string(p.join("main.tex")).unwrap();
    let rota = fuente.replacen("\\begin{tikzpicture}\n    \\draw[->] (0,0) -- (3,0)", "\\begin{tikzpicture}\n    \\comandoQueNoExiste\n    \\draw[->] (0,0) -- (3,0)", 1);
    assert_ne!(rota, fuente, "no encontré dónde romper la figura");
    fs::write(p.join("main.tex"), &rota).unwrap();
    let (ok2, code2) = compilar(&s, &r, 2);
    eprintln!("build con la figura rota: ok={ok2} código={code2:?}, subcompilaciones nuevas: {}", invocaciones(&r) - inv1);

    // Lo que la revisión vio con TeX Live: latexmk sale con 0 y la imagen es la de antes. La app no puede dejarlo así.
    let pdf_ahora = fs::read(figura(&p, 0, "pdf"));
    assert!(
        pdf_ahora.is_err() || pdf_ahora.as_ref().unwrap() != &buena0 || !ok2,
        "pgf dejó el PDF viejo de la figura rota y el build salió ok: la imagen es mentira"
    );
    assert!(!figura(&p, 0, "pdf").exists(), "el PDF de la figura que no salió se borra");
    assert!(!figura(&p, 0, "md5").exists(), "el .md5 que miente no queda en el cache compartido");
    assert!(!p.join(".lv/build/figs/figuras-cache/lv-figs-figure0.md5").exists(), "ni en el directorio del perfil");
    assert!(figura(&p, 1, "pdf").is_file() && figura(&p, 1, "md5").is_file(), "la otra figura sigue buena");

    // El error de la figura está en los problemas, con el archivo y la línea de la fuente.
    let problemas = s.problems("figs");
    let de_figura: Vec<_> = problemas.iter().filter(|x| x.kind == "figure").collect();
    assert_eq!(de_figura.len(), 1, "{problemas:#?}");
    assert!(de_figura[0].message.contains("Undefined control sequence"), "{:?}", de_figura[0]);
    assert_eq!(de_figura[0].file.as_deref(), Some("main.tex"));
    assert_eq!(de_figura[0].line, Some(31), "la línea de \\comandoQueNoExiste: {:?}", de_figura[0]);

    // 3. Sin tocar nada, el siguiente build la reintenta y sigue informando el error (no la da por buena).
    let antes = invocaciones(&r);
    let (ok3, _) = compilar(&s, &r, 3);
    assert!(invocaciones(&r) > antes, "el build siguiente tiene que reintentar la figura rota");
    assert!(!ok3, "pgf informa 'did NOT result in a usable output file' y el build falla");
    assert!(s.problems("figs").iter().any(|x| x.kind == "figure"), "el error de la figura sigue a la vista");

    // 4. Arreglada la fuente, todo vuelve a la normalidad.
    fs::write(p.join("main.tex"), &fuente).unwrap();
    let (ok4, _) = compilar(&s, &r, 4);
    assert!(ok4, "{}", r.log());
    assert!(figura(&p, 0, "pdf").is_file());
    assert!(!s.problems("figs").iter().any(|x| x.kind == "figure"));
}

#[test]
fn cancelar_un_build_que_esta_cocinando_no_deja_md5_sin_un_pdf_completo() {
    let (_t, p) = proyecto();
    // Una figura lenta para que la subcompilación todavía esté corriendo cuando se cancela.
    let lenta = fs::read_to_string(p.join("main.tex")).unwrap().replace("samples=40", "samples=60000");
    fs::write(p.join("main.tex"), lenta).unwrap();
    let r = Recolector::nuevo();
    let s = Session::open(&p, r.sink.clone()).unwrap();
    s.request_build(Some("figs")).unwrap();
    let t = std::time::Instant::now();
    while !r.log().contains("-jobname \"figuras-cache/") {
        assert!(t.elapsed().as_secs() < 120, "el build no llegó a lanzar una figura");
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    assert!(s.cancel());
    let t = std::time::Instant::now();
    while s.is_building() {
        assert!(t.elapsed().as_secs() < 60, "el build cancelado no terminó");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Lo que importa, haya o no alcanzado la figura a terminar: ningún `.md5` da por buena una figura que no está completa.
    let cache = p.join("figuras-cache");
    for e in fs::read_dir(&cache).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if let Some(base) = n.strip_suffix(".md5") {
            let pdf = fs::read(cache.join(format!("{base}.pdf"))).unwrap_or_default();
            assert!(String::from_utf8_lossy(&pdf[pdf.len().saturating_sub(1024)..]).contains("%%EOF"), "{n} da por buena una figura sin PDF completo");
        }
    }
    let en_perfil = p.join(".lv/build/figs/figuras-cache");
    for e in fs::read_dir(&en_perfil).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.ends_with(".md5") {
            panic!("{n} quedó en el directorio del perfil: o se movió verificado o se borró");
        }
    }
}
