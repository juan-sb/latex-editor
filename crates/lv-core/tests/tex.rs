//! Integración con TeX de verdad: `cargo test -p lv-core --features tex`. Compila los fixtures con el driver y el rc
//! que genera la app, desde carpetas con espacios y `ñ`. Hace falta latexmk, pdflatex y biber instalados.
#![cfg(feature = "tex")]

mod comun;

use comun::Recolector;
use lv_core::build::{BuildEvent, Builder};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture(nombre: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join(nombre)
}

/// Copia un fixture sin lo que dejó una compilación anterior (auxiliares, PDF, caches).
fn copiar(de: &Path, a: &Path) {
    fs::create_dir_all(a).unwrap();
    for e in fs::read_dir(de).unwrap().flatten() {
        let p = e.path();
        let n = e.file_name().to_string_lossy().to_string();
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if p.is_dir() {
            if n != "figuras-cache" && n != ".lv" {
                copiar(&p, &a.join(&n));
            }
        } else if !["aux", "log", "pdf", "fls", "fdb_latexmk", "gz", "bbl", "bcf", "blg", "idx", "ind", "ilg", "toc", "out", "xdv", "auxlock", "md5", "dpth"].contains(&ext)
            && !n.ends_with(".run.xml")
        {
            fs::copy(&p, a.join(&n)).unwrap();
        }
    }
}

/// Copia el fixture a `<temporal>/<nombre con espacios y ñ>` y lo compila con el perfil completo.
fn compilar(fix: &str, raiz: &str) -> (TempDir, PathBuf, Recolector, BuildEvent) {
    let tmp = TempDir::new().unwrap();
    let proyecto = tmp.path().join("pr ñ oyecto");
    copiar(&fixture(fix), &proyecto);
    let r = Recolector::nuevo();
    Builder::new().start(&proyecto, raiz, "completo", r.sink.clone()).expect("lanzar latexmk");
    let fin = r.esperar(300);
    (tmp, proyecto, r, fin)
}

fn ok_de(e: &BuildEvent) -> (bool, Option<String>) {
    match e {
        BuildEvent::Finished { ok, pdf, .. } => (*ok, pdf.clone()),
        _ => panic!("no era Finished"),
    }
}

fn solo_lv_y_fuentes(proyecto: &Path, permitidos: &[&str]) {
    let sobras: Vec<_> = fs::read_dir(proyecto)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n != ".lv" && !permitidos.contains(&n.as_str()))
        .collect();
    assert!(sobras.is_empty(), "el build ensució la raíz del proyecto: {sobras:?}");
}

#[test]
fn articulo_simple_en_una_carpeta_con_espacios_y_enie() {
    let (_t, p, r, fin) = compilar("articulo-simple", "main.tex");
    let (ok, pdf) = ok_de(&fin);
    assert!(ok, "{}", r.log());
    assert_eq!(pdf.as_deref(), Some(".lv/build/completo/lv-completo.pdf"));
    assert!(p.join(".lv/build/completo/lv-completo.pdf").is_file());
    assert!(p.join(".lv/build/completo/lv-completo.synctex.gz").is_file());
    assert!(r.log().contains("Output written on"), "el log crudo llega completo");
    solo_lv_y_fuentes(&p, &["main.tex", "README.md"]);
}

#[test]
fn libro_con_include_en_subcarpetas_con_tildes_deja_los_aux_en_el_perfil() {
    let (_t, p, r, fin) = compilar("libro-include", "main.tex");
    assert!(ok_de(&fin).0, "{}", r.log());
    let aux = p.join(".lv/build/completo/Capítulos");
    assert!(aux.join("Introducción general.aux").is_file(), "los .aux de \\include van al directorio del perfil");
    assert!(aux.join("Desarrollo").join("Análisis de datos.aux").is_file());
    // Sin referencias sin resolver al final: las pasadas siguientes resolvieron las cruzadas entre capítulos. Se mira
    // el .log de la ÚLTIMA pasada: el log crudo de latexmk trae también la primera, donde todavía no están.
    let ultimo = fs::read_to_string(p.join(".lv/build/completo/lv-completo.log")).unwrap();
    assert!(!ultimo.contains("There were undefined references"), "quedaron referencias sin resolver");
    assert!(r.log().contains("Run number 2"), "tenía que hacer más de una pasada");
    solo_lv_y_fuentes(&p, &["main.tex", "README.md", "Capítulos"]);
}

/// Regresión del paso 0: latexmk corre makeindex desde el directorio de salida y el `-s StyleInd.ist` del proyecto
/// (relativo a la raíz) no se encontraba. También ejercita biber con el `.bib` en la raíz.
#[test]
fn indice_con_estilo_del_proyecto_y_bibliografia() {
    let (_t, p, r, fin) = compilar("biblio-indice", "main.tex");
    let (ok, _) = ok_de(&fin);
    assert!(ok, "{}", r.log());
    assert!(!r.log().contains("Index style file StyleInd.ist not found"));
    assert!(p.join(".lv/build/completo/lv-completo.ind").is_file(), "makeindex generó el índice");
    assert!(p.join(".lv/build/completo/lv-completo.bbl").is_file(), "biber generó la bibliografía");
}

#[test]
fn un_segundo_build_sin_cambios_es_ok_y_no_reescribe_el_pdf() {
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("pr ñ oyecto");
    copiar(&fixture("articulo-simple"), &p);
    let b = Builder::new();
    let r1 = Recolector::nuevo();
    b.start(&p, "main.tex", "completo", r1.sink.clone()).unwrap();
    assert!(ok_de(&r1.esperar(300)).0);
    let r2 = Recolector::nuevo();
    b.start(&p, "main.tex", "completo", r2.sink.clone()).unwrap();
    match r2.esperar(300) {
        BuildEvent::Finished { ok, updated, .. } => assert!(ok && !updated, "sin cambios: ok y el PDF no se toca"),
        _ => unreachable!(),
    }
}
