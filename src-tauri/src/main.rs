// Capa fina de Tauri sobre `lv-core`: expone sus funciones como comandos y reenvía los eventos del build.
// Toda la lógica está en el core (que se prueba sin interfaz); acá sólo hay la sesión abierta y traducción de errores.
// El frontend no toca el disco ni lanza procesos: todo pasa por estos comandos.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use lv_core::build::{BuildEvent, Sink};
use lv_core::config::{State, StatePatch};
use lv_core::error::{Error, ErrorInfo};
use lv_core::fsio::{self, FileRead, WriteOutcome};
use lv_core::logparse::Problem;
use lv_core::project::{self, DirEntry};
use lv_core::session::{BuildAck, FileInfo, ProjectView, Published, Session};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, RunEvent, State as TauriState};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Arc<Session>>>,
}

type Res<T> = std::result::Result<T, ErrorInfo>;

fn otro(m: &str) -> ErrorInfo {
    Error::Other(m.to_string()).info()
}

fn sesion(state: &TauriState<'_, AppState>) -> Res<Arc<Session>> {
    state.session.lock().unwrap().clone().ok_or_else(|| otro("no hay un proyecto abierto"))
}

fn raiz(state: &TauriState<'_, AppState>) -> Res<PathBuf> {
    Ok(sesion(state)?.root.clone())
}

#[derive(Serialize)]
struct LaunchOptions {
    open: Option<String>,
    root: Option<String>,
    smoke: bool,
    /// `f1` (por defecto), `f2` o `f3`: qué smoke de aceptación corre la interfaz con `LV_SMOKE`.
    smoke_mode: String,
    smoke_file: Option<String>,
    smoke_pausa_ms: u64,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// Opciones de arranque por variables de entorno: sirven para abrir un proyecto sin diálogo y para los smokes de
/// aceptación (`LV_SMOKE=1` o `LV_SMOKE=f2`).
#[tauri::command]
async fn launch_options() -> LaunchOptions {
    let smoke = var("LV_SMOKE");
    LaunchOptions {
        open: var("LV_OPEN"),
        root: var("LV_ROOT"),
        smoke: smoke.is_some(),
        smoke_mode: match smoke.as_deref() {
            Some("f2") => "f2".into(),
            Some("f3") => "f3".into(),
            _ => "f1".into(),
        },
        smoke_file: var("LV_SMOKE_FILE"),
        smoke_pausa_ms: var("LV_SMOKE_PAUSA_MS").and_then(|v| v.parse().ok()).unwrap_or(0),
    }
}

fn solo_en_smoke() -> Res<()> {
    var("LV_SMOKE").map(|_| ()).ok_or_else(|| otro("sólo disponible con LV_SMOKE"))
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
async fn smoke_read_bytes(state: TauriState<'_, AppState>, rel: String) -> Res<Response> {
    solo_en_smoke()?;
    let ruta = fsio::resolver(&raiz(&state)?, &rel, false).map_err(|e| e.info())?;
    std::fs::read(&ruta).map(Response::new).map_err(|e| Error::Io(format!("{rel}: {e}")).info())
}

/// mtime en milisegundos: el smoke comprueba que un guardado sin cambios no toca el archivo.
#[tauri::command]
async fn smoke_mtime(state: TauriState<'_, AppState>, rel: String) -> Res<f64> {
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

/// Los eventos del build salen con el nombre del tipo: `build:started`, `build:log`, `build:finished`, `build:queued`
/// y `build:error`.
fn sink_de(app: AppHandle) -> Sink {
    Arc::new(move |ev: BuildEvent| {
        let nombre = match &ev {
            BuildEvent::Started { .. } => "build:started",
            BuildEvent::Log { .. } => "build:log",
            BuildEvent::Finished { .. } => "build:finished",
            BuildEvent::Queued { .. } => "build:queued",
            BuildEvent::Error { .. } => "build:error",
        };
        let _ = app.emit(nombre, &ev);
    })
}

#[tauri::command]
async fn open_project(app: AppHandle, state: TauriState<'_, AppState>, path: String) -> Res<ProjectView> {
    // Si había un proyecto con un build en curso, se corta: sus eventos no tienen que mezclarse con los del nuevo.
    if let Some(vieja) = state.session.lock().unwrap().take() {
        vieja.cancel();
    }
    let s = Session::open(std::path::Path::new(&path), sink_de(app)).map_err(|e| e.info())?;
    let vista = s.view().map_err(|e| e.info())?;
    *state.session.lock().unwrap() = Some(s);
    Ok(vista)
}

/// Vuelve a leer el proyecto del disco (índice de partes incluido).
#[tauri::command]
async fn get_project(state: TauriState<'_, AppState>) -> Res<ProjectView> {
    sesion(&state)?.refresh().map_err(|e| e.info())
}

#[tauri::command]
async fn set_root_file(state: TauriState<'_, AppState>, rel: String) -> Res<ProjectView> {
    sesion(&state)?.set_root(&rel).map_err(|e| e.info())
}

#[tauri::command]
async fn set_state(state: TauriState<'_, AppState>, patch: StatePatch) -> Res<State> {
    sesion(&state)?.set_state(patch).map_err(|e| e.info())
}

#[tauri::command]
async fn save_config(state: TauriState<'_, AppState>) -> Res<ProjectView> {
    sesion(&state)?.save_config().map_err(|e| e.info())
}

#[tauri::command]
async fn file_info(state: TauriState<'_, AppState>, rel: String) -> Res<FileInfo> {
    sesion(&state)?.file_info(&rel).map_err(|e| e.info())
}

#[tauri::command]
async fn list_dir(state: TauriState<'_, AppState>, rel: String) -> Res<Vec<DirEntry>> {
    project::list_dir(&raiz(&state)?, &rel).map_err(|e| e.info())
}

#[tauri::command]
async fn read_file(state: TauriState<'_, AppState>, rel: String) -> Res<FileRead> {
    fsio::read_file(&raiz(&state)?, &rel).map_err(|e| e.info())
}

#[tauri::command]
async fn write_file(state: TauriState<'_, AppState>, rel: String, text: String, expected_version: Option<String>) -> Res<WriteOutcome> {
    fsio::write_file(&raiz(&state)?, &rel, &text, expected_version.as_deref()).map_err(|e| e.info())
}

/// Bytes del PDF sin dejar ningún handle abierto: en Windows un PDF abierto bloquea la escritura de pdflatex.
#[tauri::command]
async fn read_pdf(state: TauriState<'_, AppState>, rel: String) -> Res<Response> {
    let ruta = fsio::resolver(&raiz(&state)?, &rel, false).map_err(|e| e.info())?;
    std::fs::read(&ruta).map(Response::new).map_err(|e| Error::Io(format!("{rel}: {e}")).info())
}

/// Pide un build del perfil (el activo si no se dice). Si ya hay uno corriendo queda pendiente y corre una vez después.
#[tauri::command]
async fn build(state: TauriState<'_, AppState>, profile: Option<String>) -> Res<BuildAck> {
    let s = sesion(&state)?;
    // `request_build` espera el candado de datos y lee el disco: no se hace en el hilo del runtime asíncrono.
    tauri::async_runtime::spawn_blocking(move || s.request_build(profile.as_deref()))
        .await
        .map_err(|e| otro(&e.to_string()))?
        .map_err(|e| e.info())
}

/// Los problemas del último build del perfil (errores, avisos y cajas mal llenas), con archivo y línea.
#[tauri::command]
async fn problems(state: TauriState<'_, AppState>, profile: String) -> Res<Vec<Problem>> {
    let s = sesion(&state)?;
    tauri::async_runtime::spawn_blocking(move || s.problems(&profile)).await.map_err(|e| otro(&e.to_string()))
}

#[tauri::command]
async fn cancel_build(state: TauriState<'_, AppState>) -> Res<bool> {
    Ok(sesion(&state)?.cancel())
}

#[tauri::command]
async fn publish(state: TauriState<'_, AppState>, profile: String) -> Res<Published> {
    let s = sesion(&state)?;
    tauri::async_runtime::spawn_blocking(move || s.publish(&profile))
        .await
        .map_err(|e| otro(&e.to_string()))?
        .map_err(|e| e.info())
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
            get_project,
            set_root_file,
            set_state,
            save_config,
            file_info,
            list_dir,
            read_file,
            write_file,
            read_pdf,
            build,
            cancel_build,
            problems,
            publish,
        ])
        .build(tauri::generate_context!())
        .expect("error al crear la aplicación");
    app.run(|handle, evento| {
        // Al salir se mata el árbol del build en curso: si no, un pdflatex queda huérfano hasta 5 minutos. El Job Object
        // lo cubre aunque la app muera sin pasar por acá.
        if let RunEvent::Exit = evento {
            if let Some(s) = handle.state::<AppState>().session.lock().unwrap().as_ref() {
                s.cancel();
            }
        }
    });
}
