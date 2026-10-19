//! Core de LaTeX Viewer 2. Biblioteca sin dependencias de Tauri: se prueba sin interfaz y la capa de `src-tauri` sólo
//! la expone. Todas las rutas del protocolo son relativas a la raíz del proyecto y llevan `/`.

pub mod build;
pub mod error;
pub mod fsio;
pub mod project;
