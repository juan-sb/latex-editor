use lv_core::error::Error;
use lv_core::project::{self, DirEntry};
use std::fs;
use tempfile::TempDir;

fn arbol() -> TempDir {
    let d = TempDir::new().unwrap();
    let r = d.path();
    fs::create_dir_all(r.join("Secciones")).unwrap();
    fs::create_dir_all(r.join("sub/hondo/mas")).unwrap();
    fs::create_dir_all(r.join(".lv/build")).unwrap();
    fs::create_dir_all(r.join(".git")).unwrap();
    fs::create_dir_all(r.join("figuras-cache")).unwrap();
    fs::write(r.join("principal.tex"), "% comentario\n\\documentclass{book}\n\\begin{document}\nhola\n\\end{document}\n").unwrap();
    fs::write(r.join("otra.tex"), "\\documentclass{article}\n\\input{cuerpo}\n").unwrap();
    fs::write(r.join("Zeta.tex"), "sin clase\n").unwrap();
    fs::write(r.join("Secciones/Capítulo uno.tex"), "\\chapter{x}\n").unwrap();
    fs::write(r.join("sub/c.tex"), "\\documentclass{article}\n").unwrap();
    fs::write(r.join("sub/hondo/mas/d.tex"), "\\documentclass{article}\n").unwrap(); // nivel 3: no se mira
    fs::write(r.join(".lv/build/lv-completo.tex"), "\\documentclass{article}\n").unwrap();
    fs::write(r.join(".lvtmp-1-0.tmp"), "x").unwrap();
    d
}

#[test]
fn lista_carpetas_primero_y_oculta_lv_git_y_temporales() {
    let d = arbol();
    let e = project::list_dir(d.path(), "").unwrap();
    let nombres: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(nombres, ["figuras-cache", "Secciones", "sub", "otra.tex", "principal.tex", "Zeta.tex"]);
    assert!(e[0].is_dir && !e[3].is_dir);
    assert_eq!(e[1].rel, "Secciones");
}

#[test]
fn lista_una_subcarpeta_con_rutas_relativas() {
    let d = arbol();
    let e = project::list_dir(d.path(), "Secciones").unwrap();
    assert_eq!(
        e,
        [DirEntry { name: "Capítulo uno.tex".into(), rel: "Secciones/Capítulo uno.tex".into(), is_dir: false, size: 12 }]
    );
}

#[test]
fn list_dir_rechaza_rutas_que_se_escapan_o_no_existen() {
    let d = arbol();
    assert!(matches!(project::list_dir(d.path(), ".."), Err(Error::InvalidPath(_))));
    assert!(matches!(project::list_dir(d.path(), "/etc"), Err(Error::InvalidPath(_))));
    assert!(matches!(project::list_dir(d.path(), "no-existe"), Err(Error::NotFound(_))));
}

#[test]
fn candidatas_a_dos_niveles_sin_lv_y_sin_comentarios() {
    let d = arbol();
    let p = project::open_project(d.path()).unwrap();
    assert_eq!(p.info.candidates, ["otra.tex", "principal.tex", "sub/c.tex"]);
    // Hay tres candidatas, pero sólo una trae \begin{document}.
    assert_eq!(p.info.suggested.as_deref(), Some("principal.tex"));
    assert_eq!(p.info.name, d.path().file_name().unwrap().to_string_lossy());
}

#[test]
fn una_sola_candidata_se_sugiere_sola_y_varias_sin_documento_no() {
    let d = TempDir::new().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{article}\n").unwrap();
    let p = project::open_project(d.path()).unwrap();
    assert_eq!(p.info.suggested.as_deref(), Some("main.tex"));

    // Como el libro: varias raíces y el \begin{document} en otro archivo.
    fs::write(d.path().join("cap_actual.tex"), "\\documentclass{book}\n\\input{cuerpo}\n").unwrap();
    fs::write(d.path().join("cuerpo.tex"), "\\begin{document}\n").unwrap();
    let p = project::open_project(d.path()).unwrap();
    assert_eq!(p.info.candidates.len(), 2);
    assert_eq!(p.info.suggested, None);
}

#[test]
fn abrir_algo_que_no_es_una_carpeta() {
    let d = arbol();
    assert!(matches!(project::open_project(&d.path().join("no-existe")), Err(Error::NotFound(_))));
    assert!(matches!(project::open_project(&d.path().join("principal.tex")), Err(Error::InvalidPath(_))));
}
