//! El candado por proyecto con un proceso AJENO de verdad (F8): una segunda instancia de la app sobre el mismo proyecto no compila,
//! no cocina, no exporta ni limpia, y un cierre brusco (el dueño del candado murió) no lo deja trabado.
//!
//! No se puede lanzar una segunda `lv-app.exe` desde una prueba: se hace pasar por «la app» a un `powershell` que duerme
//! (`LV_NOMBRE_APP`), que es un proceso vivo con otro PID. Es la única prueba de este archivo porque cambia una variable de entorno.
#![cfg(windows)]

use lv_core::error::Error;
use lv_core::session::Session;
use std::fs;
use std::process::{Command, Stdio};
use std::sync::Arc;

fn sesion(d: &std::path::Path) -> Arc<Session> {
    Session::open(d, Arc::new(|_| {})).unwrap()
}

fn bloqueada(e: lv_core::error::Result<impl std::fmt::Debug>) -> Option<u32> {
    match e {
        Err(Error::Locked(pid)) => Some(pid),
        _ => None,
    }
}

#[test]
fn una_segunda_instancia_ve_el_candado_de_la_primera_y_un_cierre_brusco_no_traba_el_proyecto() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{article}\\begin{document}Hola\\end{document}\n").unwrap();
    std::env::set_var("LV_NOMBRE_APP", "powershell.exe");
    let mut ajeno = Command::new("powershell").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 120"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let pid = ajeno.id();
    std::thread::sleep(std::time::Duration::from_millis(500));
    // El «dueño» tomó el candado: su PID y el nombre de su ejecutable.
    fs::create_dir_all(d.path().join(".lv")).unwrap();
    fs::write(d.path().join(".lv/lock"), format!(r#"{{ "pid": {pid}, "app": "powershell.exe", "token": 1, "desde_ms": 1 }}"#)).unwrap();

    let s = sesion(d.path());
    assert_eq!(s.view().unwrap().locked_by, Some(pid), "la vista del proyecto dice quién lo tiene");
    assert_eq!(bloqueada(s.request_build(None)), Some(pid));
    assert_eq!(bloqueada(s.request_bake()), Some(pid));
    assert_eq!(bloqueada(s.request_export(None)), Some(pid));
    assert_eq!(bloqueada(s.request_fragment("Hola".into())), Some(pid));
    assert_eq!(bloqueada(s.figures_clean()), Some(pid));
    // Editar sigue andando: es lo único que hace una instancia sin el candado.
    assert!(s.symbols().is_ok());
    // El archivo del dueño no se tocó (la segunda instancia no lo pisa ni lo suelta).
    assert!(fs::read_to_string(d.path().join(".lv/lock")).unwrap().contains(&pid.to_string()));
    drop(s);
    assert!(d.path().join(".lv/lock").is_file(), "soltar la sesión sin candado no borra el del dueño");

    // El dueño muere sin soltarlo (cierre brusco): el candado queda en disco pero ya no vale.
    ajeno.kill().unwrap();
    ajeno.wait().unwrap();
    let s2 = sesion(d.path());
    assert_eq!(s2.view().unwrap().locked_by, None, "un PID que ya no existe no traba el proyecto");
    // (`figures_clean` no lanza ningún trabajo: falla por otra cosa, que no es el candado.)
    assert_eq!(bloqueada(s2.figures_clean()), None);
    assert!(fs::read_to_string(d.path().join(".lv/lock")).unwrap().contains(&std::process::id().to_string()), "ahora el candado es de esta instancia");
    drop(s2);
    assert!(!d.path().join(".lv/lock").exists(), "y se suelta al cerrar la sesión");
}
