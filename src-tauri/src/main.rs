// Capa fina de Tauri sobre `lv-core`: expone sus funciones como comandos y reenvía los eventos del build.
// Toda la lógica está en el core (que se prueba sin interfaz); acá sólo hay estado de la aplicación y traducción de
// errores. El frontend no toca el disco ni lanza procesos: todo pasa por estos comandos.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use lv_core::build::{BuildEvent, Builder};
use lv_core::error::{Error, ErrorInfo};
use lv_core::fsio::{self, FileRead, WriteOutcome};
use lv_core::project::{self, DirEntry, Project, ProjectInfo};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

/// En F1 hay un solo perfil, el completo. Los perfiles de verdad son de F2.
const PERFIL_F1: &str = "completo";

#[derive(Default)]
struct AppState {
    project: Mutex<Option<Project>>,
    /// Raíz del documento elegida en esta sesión. No se persiste (el `latexviewer.json` es de F2).
    root_file: Mutex<Option<String>>,
    builder: Builder,
}

type Res<T> = std::result::Result<T, ErrorInfo>;

fn otro(m: &str) -> ErrorInfo {
    Error::Other(m.to_string()).info()
}

fn raiz(state: &State<'_, AppState>) -> Res<PathBuf> {
    state.project.lock().unwrap().as_ref().map(|p| p.root.clone()).ok_or_else(|| otro("no hay un proyecto abierto"))
}

#[derive(Serialize)]
struct LaunchOptions {
    open: Option<String>,
    root: Option<String>,
    smoke: bool,
    smoke_file: Option<String>,
    smoke_pausa_ms: u64,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// Opciones de arranque por variables de entorno: sirven para abrir un proyecto sin diálogo y para el smoke de
/// aceptación (`LV_SMOKE=1`).
#[tauri::command]
async fn launch_options() -> LaunchOptions {
    LaunchOptions {
        open: var("LV_OPEN"),
        root: var("LV_ROOT"),
        smoke: var("LV_SMOKE").is_some(),
        smoke_file: var("LV_SMOKE_FILE"),
        smoke_pausa_ms: var("LV_SMOKE_PAUSA_MS").and_then(|v| v.parse().ok()).unwrap_or(0),
    }
}

fn solo_en_smoke() -> Res<()> {
    var("LV_SMOKE").map(|_| ()).ok_or_else(|| otro("sólo disponible con LV_SMOKE=1"))
}

/// El resultado del smoke lo escribe Rust, en la ruta de `LV_SMOKE_OUT`: el frontend no elige dónde escribir.
#[tauri::command]
async fn write_smoke_result(json: String) -> Res<()> {
    solo_en_smoke()?;
    let destino = var("LV_SMOKE_OUT").ok_or_else(|| otro("falta LV_SMOKE_OUT"))?;
    std::fs::write(&destino, json).map_err(|e| Error::Io(format!("{destino}: {e}")).info())
}

/// Bytes crudos del archivo, para que el smoke compare lo que quedó en disco contra lo esperado byte a byte (`read_file`
/// ya devuelve el texto normalizado y no sirve para eso).
#[tauri::command]
async fn smoke_read_bytes(state: State<'_, AppState>, rel: String) -> Res<Response> {
    solo_en_smoke()?;
    let ruta = fsio::resolver(&raiz(&state)?, &rel, false).map_err(|e| e.info())?;
    std::fs::read(&ruta).map(Response::new).map_err(|e| Error::Io(format!("{rel}: {e}")).info())
}

/// mtime en milisegundos: el smoke comprueba que un guardado sin cambios no toca el archivo.
#[tauri::command]
async fn smoke_mtime(state: State<'_, AppState>, rel: String) -> Res<f64> {
    solo_en_smoke()?;
    let ruta = fsio::resolver(&raiz(&state)?, &rel, false).map_err(|e| e.info())?;
    let m = std::fs::metadata(&ruta).and_then(|m| m.modified()).map_err(|e| Error::Io(format!("{rel}: {e}")).info())?;
    Ok(m.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0))
}

#[tauri::command]
async fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// `async` a propósito: un comando sincrónico corre en el hilo principal y el diálogo lo cuelga.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Res<Option<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let elegido = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| otro(&e.to_string()))?;
    Ok(elegido.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
async fn open_project(state: State<'_, AppState>, path: String) -> Res<ProjectInfo> {
    let p = project::open_project(std::path::Path::new(&path)).map_err(|e| e.info())?;
    let info = p.info.clone();
    *state.root_file.lock().unwrap() = info.suggested.clone();
    *state.project.lock().unwrap() = Some(p);
    Ok(info)
}

#[tauri::command]
async fn set_root_file(state: State<'_, AppState>, rel: String) -> Res<()> {
    let r = raiz(&state)?;
    let ruta = fsio::resolver(&r, &rel, false).map_err(|e| e.info())?;
    if !ruta.is_file() {
        return Err(Error::NotFound(rel).info());
    }
    *state.root_file.lock().unwrap() = Some(rel);
    Ok(())
}

#[tauri::command]
async fn list_dir(state: State<'_, AppState>, rel: String) -> Res<Vec<DirEntry>> {
    project::list_dir(&raiz(&state)?, &rel).map_err(|e| e.info())
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, rel: String) -> Res<FileRead> {
    fsio::read_file(&raiz(&state)?, &rel).map_err(|e| e.info())
}

#[tauri::command]
async fn write_file(state: State<'_, AppState>, rel: String, text: String, expected_version: Option<String>) -> Res<WriteOutcome> {
    fsio::write_file(&raiz(&state)?, &rel, &text, expected_version.as_deref()).map_err(|e| e.info())
}

/// Bytes del PDF sin dejar ningún handle abierto: en Windows un PDF abierto bloquea la escritura de pdflatex.
#[tauri::command]
async fn read_pdf(state: State<'_, AppState>, rel: String) -> Res<Response> {
    let ruta = fsio::resolver(&raiz(&state)?, &rel, false).map_err(|e| e.info())?;
    std::fs::read(&ruta).map(Response::new).map_err(|e| Error::Io(format!("{rel}: {e}")).info())
}

#[tauri::command]
async fn build(app: AppHandle, state: State<'_, AppState>) -> Res<u64> {
    let r = raiz(&state)?;
    let root_file = state.root_file.lock().unwrap().clone().ok_or_else(|| otro("elegí primero la raíz del documento"))?;
    let sink: lv_core::build::Sink = Arc::new(move |ev: BuildEvent| {
        let nombre = match &ev {
            BuildEvent::Started { .. } => "build:started",
            BuildEvent::Log { .. } => "build:log",
            BuildEvent::Finished { .. } => "build:finished",
        };
        let _ = app.emit(nombre, &ev);
    });
    state.builder.start(&r, &root_file, PERFIL_F1, sink).map_err(|e| e.info())
}

#[tauri::command]
async fn cancel_build(state: State<'_, AppState>) -> Res<bool> {
    Ok(state.builder.cancel())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            launch_options,
            write_smoke_result,
            smoke_read_bytes,
            smoke_mtime,
            exit_app,
            pick_folder,
            open_project,
            set_root_file,
            list_dir,
            read_file,
            write_file,
            read_pdf,
            build,
            cancel_build,
        ])
        .build(tauri::generate_context!())
        .expect("error al crear la aplicación");
    app.run(|handle, evento| {
        // Al salir se mata el árbol del build en curso: si no, un pdflatex queda huérfano hasta 5 minutos.
        if let RunEvent::Exit = evento {
            handle.state::<AppState>().builder.cancel();
        }
    });
}
