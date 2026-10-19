//! El parser del log contra logs REALES (`fixtures/logs/`), generados por el motor de la app con `fixtures/errores`. Los
//! esperados están escritos a mano a partir de los fuentes del fixture: si un log se vuelve a generar, estos números
//! tienen que seguir coincidiendo con lo que dicen `capitulo-roto.tex`, `capitulo-ok.tex` y `main.tex`.

use lv_core::logparse::{count, parse_biber_log, parse_makeindex_log, parse_tex_log, Problem, Severity};
use std::path::{Path, PathBuf};

fn raiz() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("errores")
}

fn log(nombre: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("logs").join(nombre)).unwrap()
}

fn de<'a>(p: &'a [Problem], kind: &str) -> Vec<&'a Problem> {
    p.iter().filter(|x| x.kind == kind).collect()
}

#[test]
fn el_log_de_errores_da_cada_problema_con_su_archivo_y_su_linea() {
    let p = parse_tex_log(&log("errores.log"), &raiz());
    let c = count(&p);
    assert_eq!((c.errors, c.warnings, c.badboxes), (2, 5, 1), "{p:#?}");

    let errores: Vec<_> = p.iter().filter(|x| x.severity == Severity::Error).collect();
    assert_eq!(errores[0].message, "Undefined control sequence.");
    assert_eq!((errores[0].file.as_deref(), errores[0].line), (Some("capitulo-roto.tex"), Some(2)));
    assert!(errores[0].context.contains("comandoquenoexiste"), "el contexto muestra el lugar: {:?}", errores[0].context);
    assert_eq!(errores[1].message, "Too many }'s.");
    assert_eq!((errores[1].file.as_deref(), errores[1].line), (Some("capitulo-roto.tex"), Some(4)));

    let r = de(&p, "undefined-reference");
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].file.as_deref(), r[0].line), (Some("main.tex"), Some(11)));
    assert!(r[0].message.contains("no-existe"));
    let citas: Vec<_> = de(&p, "undefined-citation").iter().map(|x| x.message.clone()).collect();
    assert_eq!(citas.len(), 2);
    assert!(citas[0].contains("fantasma") && citas[1].contains("real"), "{citas:?}");
    assert!(de(&p, "undefined-citation").iter().all(|x| x.file.as_deref() == Some("main.tex") && x.line == Some(11)));

    // El aviso de un paquete sin línea no se atribuye a ningún archivo, y sus continuaciones `(biblatex)` se juntan.
    let paquete = de(&p, "package");
    assert_eq!(paquete.len(), 1);
    assert!(paquete[0].message.contains("csquotes") && paquete[0].message.contains("Loading 'csquotes' recommended"), "{:?}", paquete[0].message);
    assert_eq!((paquete[0].file.as_deref(), paquete[0].line), (None, None));
    let vacia = p.iter().find(|x| x.message.starts_with("Empty bibliography")).expect("bibliografía vacía");
    assert_eq!((vacia.file.as_deref(), vacia.line), (Some("main.tex"), Some(16)));
}

#[test]
fn el_overfull_de_un_parrafo_que_termina_al_empezar_otro_archivo_va_al_archivo_que_se_cerro() {
    // `(capitulo-ok.tex) (capitulo-roto.tex` y después `Overfull ... at lines 2--1`: con la pila sola iría a capitulo-roto.
    let p = parse_tex_log(&log("errores.log"), &raiz());
    let o = de(&p, "overfull");
    assert_eq!(o.len(), 1);
    assert_eq!((o[0].file.as_deref(), o[0].line, o[0].line_end), (Some("capitulo-ok.tex"), Some(2), Some(2)));
    assert_eq!(o[0].severity, Severity::Badbox);
}

#[test]
fn no_cuenta_los_resumenes_ni_las_invitaciones_a_recompilar() {
    let p = parse_tex_log(&log("errores.log"), &raiz());
    assert!(p.iter().all(|x| !x.message.contains("There were undefined references")), "{p:#?}");
    assert!(p.iter().all(|x| !x.message.contains("(re)run Biber")));
}

#[test]
fn un_archivo_que_falta_es_un_error_con_su_linea_y_el_emergency_stop() {
    let p = parse_tex_log(&log("faltante.log"), &raiz());
    let falta = de(&p, "file-not-found");
    assert_eq!(falta.len(), 1);
    assert!(falta[0].message.contains("no-esta-este-archivo.tex"));
    // El `! LaTeX Error` no trae `l.N` propio (la forma sin file-line-error): toma la línea del `Emergency stop` que sigue.
    assert_eq!((falta[0].file.as_deref(), falta[0].line), (Some("faltante.tex"), Some(5)));
    let stop = p.iter().find(|x| x.message.starts_with("Emergency stop")).expect("Emergency stop");
    assert_eq!((stop.file.as_deref(), stop.line), (Some("faltante.tex"), Some(5)));
    // El "Fatal error occurred" que repite latexmk no es un problema más.
    assert!(p.iter().all(|x| !x.message.contains("Fatal error")), "{p:#?}");
    assert_eq!(count(&p).errors, 2);
}

#[test]
fn biber_da_su_error_con_el_archivo_y_la_linea_del_bib_sin_la_ruta_del_temporal() {
    let p = parse_biber_log(&log("biber.blg"), &raiz());
    assert_eq!(p.len(), 1, "{p:#?}");
    assert_eq!(p[0].severity, Severity::Error);
    assert_eq!(p[0].kind, "biber");
    assert_eq!((p[0].file.as_deref(), p[0].line), (Some("refs.bib"), Some(10)));
    assert!(p[0].message.contains("syntax error") && !p[0].message.contains("biber_tmp"), "{:?}", p[0].message);
}

#[test]
fn biber_avisos_y_makeindex_con_el_formato_de_sus_logs() {
    let blg = "[10] Biber.pm:99> INFO - Found BibTeX data source 'refs.bib'\n[11] Biber.pm:1> WARN - I didn't find a database entry for 'fantasma' (section 0)\n[12] Biber.pm:2> WARN - Entry 'x' (refs.bib), line 3: year field is not numeric\n";
    let p = parse_biber_log(blg.as_bytes(), &raiz());
    assert_eq!(p.len(), 2);
    assert!(p[0].message.contains("fantasma") && p[0].file.is_none() && p[0].severity == Severity::Warning);
    assert_eq!((p[1].file.as_deref(), p[1].line), (Some("refs.bib"), Some(3)));

    let ilg = "This is makeindex, version 2.17\n!! Input index error (file = x.idx, line = 12):\n   -- Missing arguments -- need two.\n## Warning (input = x.idx, line = 4; output = x.ind):\n   -- Extra ] at position 7.\n";
    let m = parse_makeindex_log(ilg.as_bytes(), &raiz());
    assert_eq!(m.len(), 2);
    assert_eq!((m[0].severity, m[0].line), (Severity::Error, Some(12)));
    assert!(m[0].message.contains("Missing arguments"));
    assert_eq!((m[1].severity, m[1].line), (Severity::Warning, Some(4)));
    assert!(m.iter().all(|x| x.kind == "makeindex" && x.file.is_none()), "x.idx no está en el proyecto");
}

#[test]
fn bytes_invalidos_rutas_con_espacios_y_parentesis_sueltos_no_rompen_ni_desalinean_la_pila() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("Secciones")).unwrap();
    std::fs::write(d.path().join("Secciones/Aproximación de Cauer.tex"), "x").unwrap();
    std::fs::write(d.path().join("main.tex"), "x").unwrap();
    let mut log = Vec::new();
    log.extend_from_slice("(./main.tex (C:\\MiKTeX\\tex\\latex\\base\\article.cls\nDocument Class: article (a) (b\n)\n [3 <./figuras/x.pdf>] (Secciones/Aproximación de Cauer.tex\n".as_bytes());
    log.extend_from_slice(b"Overfull \\hbox (1.5pt too wide) in paragraph at lines 7--8\n[]\\T1/cmr/m/n/10 l\xed-nea\n []\n\n");
    log.extend_from_slice("LaTeX Warning: Reference `x' on page 2 undefined on input line 9.\n\n) (otro (paréntesis suelto en un texto\n".as_bytes());
    log.extend_from_slice("LaTeX Warning: Citation 'k' on page 3 undefined on input line 4.\n\n".as_bytes());
    let p = parse_tex_log(&log, d.path());
    assert_eq!(p.len(), 3, "{p:#?}");
    assert_eq!((p[0].file.as_deref(), p[0].line, p[0].line_end), (Some("Secciones/Aproximación de Cauer.tex"), Some(7), Some(8)));
    assert_eq!((p[1].file.as_deref(), p[1].line), (Some("Secciones/Aproximación de Cauer.tex"), Some(9)));
    // Después del `)` que cierra Cauer vuelve main.tex... (el `(otro (...` no es una ruta y no se apila).
    assert_eq!((p[2].file.as_deref(), p[2].line), (Some("main.tex"), Some(4)), "{p:#?}");
}

#[test]
fn los_errores_sin_file_line_error_toman_el_archivo_de_la_pila_y_la_linea_de_l_n() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("cap.tex"), "x").unwrap();
    let log = "(./cap.tex\n! Undefined control sequence.\n<recently read> \\foo \nl.12\\foo\n         bar\nThe control sequence at the end of the top line\n\n)\n";
    let p = parse_tex_log(log.as_bytes(), d.path());
    assert_eq!(p.len(), 1, "{p:#?}");
    assert_eq!((p[0].file.as_deref(), p[0].line), (Some("cap.tex"), Some(12)).clone().into(), "{p:#?}");
}

#[test]
fn el_mismo_problema_repetido_se_cuenta_una_vez() {
    let log = "LaTeX Warning: Reference `x' on page 1 undefined on input line 3.\n\nLaTeX Warning: Reference `x' on page 2 undefined on input line 3.\n\n";
    let p = parse_tex_log(log.as_bytes(), Path::new("."));
    // Mismo mensaje salvo la página: son dos mensajes distintos, y cada uno se cuenta una vez.
    assert_eq!(p.len(), 2);
    let igual = "LaTeX Warning: Reference `x' on page 1 undefined on input line 3.\n\n".repeat(3);
    assert_eq!(parse_tex_log(igual.as_bytes(), Path::new(".")).len(), 1);
}

#[test]
fn un_log_vacio_o_de_basura_no_da_problemas() {
    assert!(parse_tex_log(b"", Path::new(".")).is_empty());
    assert!(parse_tex_log(&[0xff, 0xfe, 0x00, b'(', b')', b')', b'\n'], Path::new(".")).is_empty());
}

#[test]
fn las_cajas_sin_linea_se_cuentan_todas_como_un_grep_del_log() {
    let una = "Underfull \\vbox (badness 10000) has occurred while \\output is active []\n\n";
    let p = parse_tex_log(una.repeat(5).as_bytes(), Path::new("."));
    assert_eq!(p.len(), 5);
    assert!(p.iter().all(|x| x.severity == Severity::Badbox && x.file.is_none() && x.line.is_none()));
}
