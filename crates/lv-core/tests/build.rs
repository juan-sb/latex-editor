//! Tests del runner de `build` con un "latexmk" falso (un script de PowerShell): no hace falta TeX instalado. Los
//! tests con TeX de verdad están en `tex.rs` (`--features tex`). Son sólo para Windows: la app lo es.
#![cfg(windows)]

mod comun;

use comun::Recolector;
use lv_core::build::{BuildEvent, Builder};
use lv_core::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const CREA_PDF: &str = "New-Item -ItemType Directory -Force '.lv/build/completo' | Out-Null\nSet-Content '.lv/build/completo/lv-completo.pdf' 'x'\n";

fn proyecto() -> TempDir {
    let d = TempDir::new().unwrap();
    fs::write(d.path().join("main.tex"), "\\documentclass{article}\n").unwrap();
    d
}

/// Un Builder que, en lugar de latexmk, corre `cuerpo` como script de PowerShell con los mismos argumentos.
fn falso(dir: &Path, cuerpo: &str) -> Builder {
    let script = dir.join("falso.ps1");
    fs::write(&script, cuerpo).unwrap();
    // El script vive afuera de `.lv` para no mezclarse con lo que genera la app.
    Builder::con_programa(
        "powershell",
        vec!["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].into_iter().map(OsString::from).chain([script.into_os_string()]).collect(),
    )
}

fn finished(e: BuildEvent) -> (bool, Option<i32>, bool, Option<String>, bool) {
    match e {
        BuildEvent::Finished { ok, code, cancelled, pdf, updated, .. } => (ok, code, cancelled, pdf, updated),
        otro => panic!("no era Finished: {otro:?}"),
    }
}

#[test]
fn el_entorno_del_build_pide_el_log_sin_cortes_para_tex_live() {
    let d = proyecto();
    let b = falso(d.path(), &format!("\"max_print_line=$env:max_print_line\"\n{CREA_PDF}"));
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, ..) = finished(r.esperar(60));
    assert!(ok);
    assert!(r.log().contains("max_print_line=10000"), "{}", r.log());
}

#[test]
fn bytes_invalidos_y_sin_salto_final_no_cortan_la_salida() {
    let d = proyecto();
    let script = format!(
        "$o = [Console]::OpenStandardOutput()\n$b = [byte[]](0x61,0x62,0xFF,0xFE,0x63,0x64)\n$o.Write($b,0,$b.Length)\n$o.Flush()\n{CREA_PDF}"
    );
    let b = falso(d.path(), &script);
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, code, cancelled, pdf, updated) = finished(r.esperar(60));
    assert_eq!(r.log(), "ab\u{FFFD}\u{FFFD}cd", "la salida llega completa, sin salto final y con reemplazos");
    assert!(ok && !cancelled && updated);
    assert_eq!(code, Some(0));
    assert_eq!(pdf.as_deref(), Some(".lv/build/completo/lv-completo.pdf"));
}

#[test]
fn una_inundacion_de_stderr_no_bloquea_el_build() {
    let d = proyecto();
    let script = "$e = [Console]::OpenStandardError()\n$b = [System.Text.Encoding]::ASCII.GetBytes(('x' * 1023) + \"`n\")\nfor ($i = 0; $i -lt 5120; $i++) { $e.Write($b,0,$b.Length) }\n$e.Flush()\n";
    let b = falso(d.path(), script);
    let r = Recolector::nuevo();
    let t = Instant::now();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, code, ..) = finished(r.esperar(60));
    assert!(!ok, "sin PDF no es ok");
    assert_eq!(code, Some(0));
    assert!(r.log().len() >= 5 * 1024 * 1024, "llegaron {} bytes", r.log().len());
    assert!(r.cantidad_de_logs() >= 2, "tiene que llegar en varios lotes");
    assert!(t.elapsed() < Duration::from_secs(40));
}

#[test]
fn un_segundo_build_mientras_corre_el_primero_da_ocupado() {
    let d = proyecto();
    let b = falso(d.path(), "Start-Sleep -Seconds 3\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    assert!(b.is_running());
    let r2 = Recolector::nuevo();
    assert!(matches!(b.start(d.path(), "main.tex", "completo", r2.sink.clone()), Err(Error::Busy)));
    r.esperar(60);
    assert!(!b.is_running());
    // Libre otra vez.
    b.start(d.path(), "main.tex", "completo", r2.sink.clone()).unwrap();
    r2.esperar(60);
}

fn procesos_con(marca: &str) -> usize {
    let o = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -match '{marca}' -and $_.Name -match 'ping' }} | Measure-Object).Count")])
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(99)
}

#[test]
fn cancelar_mata_todo_el_arbol() {
    let d = proyecto();
    // Un nieto que no termina solo: el árbol es powershell -> ping.
    let b = falso(d.path(), "& ping.exe -n 3171 127.0.0.1 | Out-Null\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(procesos_con(" 3171 "), 1, "el ping de prueba tenía que estar vivo");
    assert!(b.cancel());
    let (ok, code, cancelled, ..) = finished(r.esperar(15));
    assert!(cancelled && !ok);
    assert_ne!(code, Some(0));
    let t = Instant::now();
    while procesos_con(" 3171 ") != 0 {
        assert!(t.elapsed() < Duration::from_secs(2), "quedó un proceso vivo");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!b.is_running());
    assert!(!b.cancel(), "sin build en curso no hay nada que cancelar");
}

#[test]
fn sin_latexmk_el_error_dice_cual_programa_falta() {
    let d = proyecto();
    let b = Builder::con_programa("lv-no-existe-xyz", vec![]);
    let r = Recolector::nuevo();
    match b.start(d.path(), "main.tex", "completo", r.sink.clone()) {
        Err(Error::NoLatexmk(m)) => assert!(m.contains("lv-no-existe-xyz"), "{m}"),
        otro => panic!("tenía que ser NoLatexmk: {otro:?}"),
    }
    assert!(!b.is_running(), "un fallo al lanzar no puede dejar el builder ocupado");
}

#[test]
fn codigo_distinto_de_cero_con_pdf_no_es_ok() {
    let d = proyecto();
    let b = falso(d.path(), &format!("{CREA_PDF}exit 12\n"));
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, code, _, pdf, updated) = finished(r.esperar(60));
    assert!(!ok, "latexmk sale con 12 aunque deje un PDF");
    assert_eq!(code, Some(12));
    assert!(pdf.is_some() && updated);
}

#[test]
fn codigo_cero_sin_pdf_no_es_ok() {
    let d = proyecto();
    let b = falso(d.path(), "exit 0\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, code, _, pdf, _) = finished(r.esperar(60));
    assert!(!ok);
    assert_eq!(code, Some(0));
    assert_eq!(pdf, None);
}

#[test]
fn un_build_sin_cambios_sale_con_cero_sin_tocar_el_pdf_y_es_ok() {
    let d = proyecto();
    fs::create_dir_all(d.path().join(".lv/build/completo")).unwrap();
    fs::write(d.path().join(".lv/build/completo/lv-completo.pdf"), "viejo").unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let b = falso(d.path(), "exit 0\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    let (ok, _, _, pdf, updated) = finished(r.esperar(60));
    assert!(ok, "latexmk dice 'todo al día' y sale con 0: no es un error");
    assert!(!updated, "el PDF no se reescribió");
    assert!(pdf.is_some());
}

#[test]
fn el_orden_de_los_eventos_es_started_logs_finished() {
    let d = proyecto();
    let b = falso(d.path(), "Write-Output 'hola'\n");
    let r = Recolector::nuevo();
    let id = b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    r.esperar(60);
    let ev = r.eventos.lock().unwrap();
    assert!(matches!(ev.first(), Some(BuildEvent::Started { id: i, perfil, .. }) if *i == id && perfil == "completo"));
    assert!(matches!(ev.last(), Some(BuildEvent::Finished { id: i, .. }) if *i == id), "el final no puede llegar antes que las últimas líneas");
    assert!(ev[1..ev.len() - 1].iter().all(|e| matches!(e, BuildEvent::Log { id: i, .. } if *i == id)));
    assert!(ev.iter().any(|e| matches!(e, BuildEvent::Log { text, .. } if text.contains("hola"))));
}

#[test]
fn pasa_el_perfil_el_directorio_y_la_linea_de_comandos() {
    let d = proyecto();
    let b = falso(d.path(), "Write-Output \"PERFIL=$env:LV_PERFIL\"\nWrite-Output \"CWD=$((Get-Location).Path)\"\nWrite-Output \"ARGS=$($args -join ' ')\"\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    r.esperar(60);
    let log = r.log();
    assert!(log.contains("PERFIL=completo"), "{log}");
    assert!(log.contains(d.path().file_name().unwrap().to_str().unwrap()), "cwd = la raíz del proyecto: {log}");
    for esperado in ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-file-line-error", "-latexoption=-max-print-line=10000", "-r .lv/latexmkrc", ".lv/drivers/lv-completo.tex"] {
        assert!(log.contains(esperado), "falta {esperado:?} en {log}");
    }
}

#[test]
fn genera_el_driver_y_el_rc_en_lv_y_no_los_reescribe_si_no_cambian() {
    let d = proyecto();
    let b = falso(d.path(), "exit 0\n");
    let r = Recolector::nuevo();
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    r.esperar(60);
    let driver = d.path().join(".lv/drivers/lv-completo.tex");
    let rc = d.path().join(".lv/latexmkrc");
    assert_eq!(fs::read_to_string(&driver).unwrap(), lv_core::build::render_driver("completo", "main.tex").unwrap());
    assert_eq!(fs::read_to_string(&rc).unwrap(), lv_core::build::render_latexmkrc());
    let (m1, m2) = (fs::metadata(&driver).unwrap().modified().unwrap(), fs::metadata(&rc).unwrap().modified().unwrap());
    std::thread::sleep(Duration::from_millis(50));
    b.start(d.path(), "main.tex", "completo", r.sink.clone()).unwrap();
    // El segundo `Finished` es el último evento recibido.
    let t = Instant::now();
    while b.is_running() {
        assert!(t.elapsed() < Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(fs::metadata(&driver).unwrap().modified().unwrap(), m1, "tocar el driver haría recompilar a latexmk");
    assert_eq!(fs::metadata(&rc).unwrap().modified().unwrap(), m2);
    // Y no se escribe nada afuera de .lv (el script falso está en la raíz, es del test).
    let sobras: Vec<_> = fs::read_dir(d.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !["main.tex", "falso.ps1", ".lv"].contains(&n.as_str()))
        .collect();
    assert!(sobras.is_empty(), "{sobras:?}");
}

#[test]
fn rechaza_raices_que_rompen_input_y_las_que_no_existen() {
    let d = proyecto();
    fs::write(d.path().join("a#b.tex"), "\\documentclass{article}\n").unwrap();
    let b = falso(d.path(), "exit 0\n");
    let r = Recolector::nuevo();
    assert!(matches!(b.start(d.path(), "a#b.tex", "completo", r.sink.clone()), Err(Error::InvalidPath(_))));
    assert!(matches!(b.start(d.path(), "no-existe.tex", "completo", r.sink.clone()), Err(Error::NotFound(_))));
    assert!(matches!(b.start(d.path(), "../fuera.tex", "completo", r.sink.clone()), Err(Error::InvalidPath(_))));
    assert!(!b.is_running(), "un rechazo previo no puede dejar el builder ocupado");
}
