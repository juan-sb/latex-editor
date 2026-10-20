//! Aceptación de la pantalla «Proyecto» (F8b), del lado del core: abrir un proyecto SIN `latexviewer.json` y llegar, sólo con lo que se
//! detecta, a la configuración que se escribió a mano (`fixtures/configs/`). El del libro es la copia de `inspo/Proyecto` en
//! `fixtures/libro-tc` (la arma `scripts/copiar-libro.ps1`; si no está, esa prueba se saltea). Nada se escribe en las carpetas.

use lv_core::config::ProjectConfig;
use lv_core::detectar::{detectar, RolDeRaiz};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures")
}

fn esperada(nombre: &str) -> ProjectConfig {
    let t = std::fs::read_to_string(fixtures().join("configs").join(nombre)).unwrap();
    serde_json::from_str(&t).unwrap_or_else(|e| panic!("{nombre}: {e}"))
}

fn detectada(carpeta: &Path) -> lv_core::detectar::Propuesta {
    detectar(carpeta, None, None, &BTreeMap::new()).unwrap()
}

fn como_config(p: &lv_core::detectar::Propuesta) -> ProjectConfig {
    // El texto que la pantalla guarda es el que se lee de vuelta.
    serde_json::from_str(&p.texto).unwrap()
}

#[test]
fn el_libro_de_inspo_llega_a_su_configuracion_sin_escribir_nada_a_mano() {
    let libro = fixtures().join("libro-tc");
    if !libro.join("Funciones de Aproximación.tex").is_file() {
        eprintln!("(se saltea: falta fixtures/libro-tc, ver scripts/copiar-libro.ps1)");
        return;
    }
    let p = detectada(&libro);
    // Las raíces: el documento es la principal; las cuatro del libro que recortan o definen flags son auxiliares.
    let rol = |a: &str| p.candidatas.iter().find(|c| c.archivo == a).map(|c| c.rol);
    assert_eq!(p.raiz, "Funciones de Aproximación.tex");
    assert_eq!(rol("Funciones de Aproximación.tex"), Some(RolDeRaiz::Principal));
    for aux in ["cap_actual.tex", "libro_fast.tex", "libro_cocina.tex", "libro_export.tex"] {
        assert_eq!(rol(aux), Some(RolDeRaiz::Auxiliar), "{aux}");
    }
    assert!(p.candidatas.iter().find(|c| c.archivo == "cap_actual.tex").unwrap().motivo.contains("\\includeonly{Secciones/Desnormalización}"));
    assert_eq!(p.partes.len(), 8);
    assert_eq!(p.parts_commands, ["include", "Capitulo"]);
    // El `\def` incondicional de la variable del libro sin parchear se explica ahí.
    let v = p.variables.iter().find(|v| v.nombre == "OpcionPie").expect("la variable OpcionPie");
    assert_eq!(v.choices, ["completo", "autor", "ninguno"]);
    assert!(!v.def_sin_guardia.is_empty() || libro.join("structure.tex").is_file());

    // La configuración que sale es la del fixture. La etiqueta de la variable no se puede deducir de los textos («Pie» contra «Pie de
    // página»): es lo único que se edita a mano en la pantalla, y acá se iguala.
    let mut sale = como_config(&p);
    let mut debe = esperada("libro-tc.latexviewer.json");
    for c in [&mut sale, &mut debe] {
        for v in c.variables.values_mut() {
            v.label = None;
        }
    }
    assert_eq!(sale, debe);
    assert_eq!(p.salidas.ejemplo_nombre.as_deref(), Some("PDF/Capítulos/01 - Funciones de Aproximación.pdf"));
}

#[test]
fn libro_include_y_articulo_simple_llegan_a_su_configuracion() {
    for (carpeta, esperado) in [("libro-include", "libro-include.latexviewer.json"), ("articulo-simple", "articulo-simple.latexviewer.json")] {
        let p = detectada(&fixtures().join(carpeta));
        assert_eq!(como_config(&p), esperada(esperado), "{carpeta}");
        assert_eq!(p.raiz, "main.tex");
    }
}

#[test]
fn una_configuracion_guardada_manda_sobre_la_recomendada_y_el_texto_se_lee_de_vuelta() {
    let libro = fixtures().join("libro-include");
    let mut cfg = esperada("libro-include.latexviewer.json");
    cfg.root = "main.tex".into();
    let p = detectar(&libro, None, Some(&cfg), &BTreeMap::new()).unwrap();
    assert_eq!(p.raiz, "main.tex");
    // El texto termina con un salto de línea y se parsea con la misma estructura que escribe `save_config`.
    assert!(p.texto.ends_with("}\n"));
    assert_eq!(serde_json::from_str::<ProjectConfig>(&p.texto).unwrap(), como_config(&p));
}
