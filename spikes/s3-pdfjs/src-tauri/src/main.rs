// Spike S3: el lado Rust sólo lee bytes de PDF, mide memoria, recompila el rápido y guarda resultados.
// El frontend no toca el disco (regla de 3.2 del plan): todo pasa por estos comandos.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::json;
use std::{fs, process::Command, time::Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::ipc::Response;

/// Configuración que le pasa el script que lanza el spike, por variables de entorno.
#[tauri::command]
fn config() -> serde_json::Value {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    json!({
        "proyecto": var("S3_PROYECTO"),
        "pdfRapido": var("S3_PDF_RAPIDO"),
        "pdfCompleto": var("S3_PDF_COMPLETO"),
        "salida": var("S3_SALIDA"),
        // Opcionales: cantidad de recargas por técnica y qué casos correr (p. ej. "rapido_B,completo_B").
        "reps": var("S3_REPS"),
        "solo": var("S3_SOLO"),
    })
}

/// Devuelve los bytes del PDF. No deja ningún handle abierto: en Windows un PDF abierto bloquea la
/// escritura de pdflatex (plan.md 5.2).
#[tauri::command]
fn read_pdf(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_result(path: String, json: String) -> Result<(), String> {
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Memoria física (working set) de este proceso y de todos sus descendientes, que es donde vive WebView2.
#[tauri::command]
fn mem_mb() -> f64 {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let yo = Pid::from_u32(std::process::id());
    let mut familia = vec![yo];
    loop {
        let antes = familia.len();
        for (pid, p) in sys.processes() {
            if let Some(padre) = p.parent() {
                if familia.contains(&padre) && !familia.contains(pid) {
                    familia.push(*pid);
                }
            }
        }
        if familia.len() == antes {
            break;
        }
    }
    familia.iter().filter_map(|p| sys.process(*p)).map(|p| p.memory() as f64).sum::<f64>() / 1048576.0
}

/// Cambia una palabra de Desnormalización (como un guardado) y recompila `libro_fast.tex` con latexmk.
/// Devuelve (segundos, código de salida). El PDF queda en la carpeta PDF hermana, que es lo que el visor
/// está mostrando mientras tanto.
#[tauri::command]
fn compile_fast(proyecto: String, n: u32) -> Result<(f64, i32), String> {
    let ruta = format!("{proyecto}\\Secciones\\Desnormalización.tex");
    let texto = fs::read_to_string(&ruta).map_err(|e| e.to_string())?;
    let nuevo = if let Some(i) = texto.find("Las bench") {
        let fin = texto[i..].find(" secciones anteriores").ok_or("ancla rota")? + i;
        format!("{}Las bench{}{}", &texto[..i], n, &texto[fin..])
    } else {
        texto.replacen("Las secciones anteriores", &format!("Las bench{n} secciones anteriores"), 1)
    };
    fs::write(&ruta, nuevo).map_err(|e| e.to_string())?;
    let t = Instant::now();
    let o = Command::new("latexmk")
        .args(["-pdf", "-shell-escape", "-interaction=nonstopmode", "-synctex=1", "libro_fast.tex"])
        .current_dir(&proyecto)
        .output()
        .map_err(|e| e.to_string())?;
    Ok((t.elapsed().as_secs_f64(), o.status.code().unwrap_or(-1)))
}

#[tauri::command]
fn salir(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![config, read_pdf, write_result, mem_mb, compile_fast, salir])
        .run(tauri::generate_context!())
        .expect("error al correr la app");
}
