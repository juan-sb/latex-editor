//! El doctor y los huérfanos vistos desde la sesión (F8), sin TeX: las herramientas las contesta una sonda falsa y el huérfano es un
//! proceso de verdad con nombre de TeX (un `ping.exe` copiado como `pdflatex.exe`) y la raíz del proyecto como directorio actual.

use lv_core::doctor::{Nivel, Salida};
use lv_core::session::Session;
use std::fs;
use std::path::Path;
use std::sync::Arc;

fn sesion(d: &Path) -> Arc<Session> {
    Session::open(d, Arc::new(|_| {})).unwrap()
}

fn sonda_sana(nombre: &str, args: &[&str], _: Option<&Path>) -> Salida {
    let ok = |t: &str| Salida { lanzado: true, codigo: Some(0), texto: t.into(), colgado: false };
    match nombre {
        "pdflatex" if args.contains(&"--version") => ok("pdfTeX 3.14 (MiKTeX 26.5)"),
        "pdflatex" => ok("LVFMT:2026-06-01\nLVSE:1\n"),
        "latexmk" if args.contains(&"-e") => ok("LVPATH=C:\\a;C:\\b;C:\\c;C:\\d\n"),
        "latexmk" => ok("Latexmk Version 4.88\n"),
        "perl" => ok("This is perl 5\n"),
        _ => ok("ok\n"),
    }
}

#[test]
fn el_doctor_de_la_sesion_ve_el_def_sin_guardia_al_abrir_una_copia_sin_parchear() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{book}\n\\input{structure}\n\\begin{document}\nHola\n\\end{document}\n").unwrap();
    fs::write(d.path().join("structure.tex"), "\\def\\OpcionPie{completo}\n").unwrap();
    fs::write(
        d.path().join("latexviewer.json"),
        r#"{ "root": "main.tex", "variables": { "OpcionPie": { "choices": ["completo", "autor"], "default": "completo" } }, "profiles": { "completo": {} } }"#,
    )
    .unwrap();
    let s = sesion(d.path());
    let i = s.doctor_con(&sonda_sana).unwrap();
    let v: Vec<_> = i.hallazgos.iter().filter(|h| h.id == "variable-def").collect();
    assert_eq!(v.len(), 1, "{:#?}", i.hallazgos);
    assert_eq!((v[0].nivel, v[0].archivo.as_deref(), v[0].linea), (Nivel::Aviso, Some("structure.tex"), Some(1)));
    assert_eq!(i.distribucion.as_deref(), Some("MiKTeX 26.5"));
    // Lo grave va primero: no hay errores, así que el primero es un aviso.
    assert!(i.hallazgos.iter().all(|h| h.nivel != Nivel::Error), "{:#?}", i.hallazgos);
    assert_eq!(i.hallazgos[0].nivel, Nivel::Aviso);
    // Con la guardia puesta, el aviso desaparece.
    fs::write(d.path().join("structure.tex"), "\\ifdefined\\OpcionPie\\else\\def\\OpcionPie{completo}\\fi\n").unwrap();
    s.refresh().unwrap();
    let i = s.doctor_con(&sonda_sana).unwrap();
    assert!(i.hallazgos.iter().all(|h| h.nivel < Nivel::Aviso), "{:#?}", i.hallazgos);
}

/// Con TeX de verdad (`--features tex`): las sondas del doctor andan contra MiKTeX/TeX Live y no sólo contra salidas falsas. En
/// particular la del PATH que ve Perl adentro de latexmk, que no sale con `-v` y hay que pedirla con `-e` y `-c`.
#[cfg(feature = "tex")]
#[test]
fn el_doctor_contra_tex_de_verdad_no_da_errores_y_ve_el_path_de_latexmk() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{article}\\begin{document}Hola\\end{document}\n").unwrap();
    let s = sesion(d.path());
    let i = s.doctor().unwrap();
    assert!(i.hallazgos.iter().all(|h| h.nivel != Nivel::Error), "{:#?}", i.hallazgos);
    for id in ["motor", "nucleo", "latexmk", "perl"] {
        assert!(i.hallazgos.iter().any(|h| h.id == id && h.nivel == Nivel::Ok), "{id}: {:#?}", i.hallazgos);
    }
    let p = i.hallazgos.iter().find(|h| h.id == "path-latexmk").unwrap_or_else(|| panic!("sin hallazgo del PATH: {:#?}", i.hallazgos));
    assert!(!p.titulo.contains("No se pudo leer"), "{p:?}");
    assert!(i.distribucion.is_some());
    // El doctor no deja nada en el proyecto (ni el x.tex de la sonda, ni nada de latexmk).
    let mut nombres: Vec<String> = fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    nombres.sort();
    assert_eq!(nombres, [".lv", "main.tex"]);
}

#[cfg(windows)]
#[test]
fn un_proceso_de_tex_del_proyecto_que_quedo_de_antes_se_ofrece_y_se_mata_pero_otro_pid_no() {
    use std::process::{Command, Stdio};
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{article}\\begin{document}Hola\\end{document}\n").unwrap();
    let bin = tempfile::tempdir().unwrap();
    let falso = bin.path().join("pdflatex.exe");
    fs::copy(Path::new(&std::env::var("SystemRoot").unwrap()).join("System32").join("ping.exe"), &falso).unwrap();
    let mut huerfano = Command::new(&falso).args(["-n", "120", "127.0.0.1"]).current_dir(d.path()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    // Uno de otro proyecto (otra carpeta) no es de este.
    let otra = tempfile::tempdir().unwrap();
    let mut ajeno = Command::new(&falso).args(["-n", "120", "127.0.0.1"]).current_dir(otra.path()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(800));

    let s = sesion(d.path());
    let h = s.huerfanos();
    assert_eq!(h.iter().map(|p| p.pid).collect::<Vec<_>>(), [huerfano.id()], "sólo el de este proyecto: {h:?}");
    assert_eq!(h[0].nombre.to_lowercase(), "pdflatex.exe");
    // El doctor lo informa.
    let i = s.doctor_con(&sonda_sana).unwrap();
    assert!(i.hallazgos.iter().any(|x| x.id == "huerfanos" && x.detalle.contains(&huerfano.id().to_string())), "{:#?}", i.hallazgos);
    // Matar un PID que no es huérfano de este proyecto no hace nada.
    assert!(s.matar_huerfanos(&[ajeno.id()]).unwrap().is_empty());
    assert!(ajeno.try_wait().unwrap().is_none(), "el de otro proyecto sigue vivo");
    assert_eq!(s.matar_huerfanos(&[huerfano.id()]).unwrap(), [huerfano.id()]);
    let t = std::time::Instant::now();
    while huerfano.try_wait().unwrap().is_none() {
        assert!(t.elapsed().as_secs() < 10, "no murió");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(s.huerfanos().is_empty());
    let _ = ajeno.kill();
    let _ = ajeno.wait();
}
