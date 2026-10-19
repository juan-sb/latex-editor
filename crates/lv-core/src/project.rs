//! Abrir una carpeta como proyecto, listar sus carpetas y proponer la raíz del documento.
//!
//! En F1 la raíz no se guarda en ningún lado (el `latexviewer.json` es de F2): o es la única candidata, o la elige el
//! usuario, o viene de `LV_ROOT`.

use crate::error::{Error, Result};
use crate::fsio;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Carpetas que no se muestran en el árbol ni se recorren buscando raíces.
const OCULTAS: [&str; 3] = [".lv", ".git", "node_modules"];

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    /// Ruta real del proyecto (sin `\\?\`).
    pub root: String,
    /// Archivos `.tex` con `\documentclass`, relativos a la raíz y con `/`.
    pub candidates: Vec<String>,
    /// La raíz que se puede asumir sin preguntar: la única candidata, o la única que además trae `\begin{document}`.
    pub suggested: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    /// Relativa a la raíz, con `/`.
    pub rel: String,
    pub is_dir: bool,
    pub size: u64,
}

pub struct Project {
    pub root: PathBuf,
    pub info: ProjectInfo,
}

pub fn open_project(path: &Path) -> Result<Project> {
    if !path.exists() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    if !path.is_dir() {
        return Err(Error::InvalidPath(format!("{}: no es una carpeta", path.display())));
    }
    let root = dunce::canonicalize(path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.display().to_string());
    let candidates = find_root_candidates(&root);
    let suggested = suggest(&root, &candidates);
    let info = ProjectInfo { name, root: root.display().to_string(), candidates, suggested };
    Ok(Project { root, info })
}

fn nombre_oculto(n: &str) -> bool {
    OCULTAS.contains(&n) || n.starts_with(".lvtmp-")
}

/// Carpeta perezosa: carpetas primero, después archivos, cada grupo por nombre sin distinguir mayúsculas.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<DirEntry>> {
    let dir = fsio::resolver(root, rel, true)?;
    let rd = fs::read_dir(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(rel.to_string()),
        _ => Error::Io(format!("{rel:?}: {e}")),
    })?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if nombre_oculto(&name) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let rel_hijo = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        out.push(DirEntry { name, rel: rel_hijo, is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() } });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

fn lineas_utiles(texto: &str) -> impl Iterator<Item = &str> {
    texto.lines().map(str::trim_start).filter(|l| !l.starts_with('%'))
}

/// Primeros 64 KB del archivo: alcanza para el preámbulo y evita leer capítulos enteros.
fn cabecera(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(65536);
    fs::File::open(path).ok()?.take(65536).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

/// `.tex` con `\documentclass`, hasta dos niveles de profundidad. En el libro hay cinco, y `\begin{document}` está
/// en `libro_cuerpo.tex`, que entra por `\input`: no se puede decidir sólo mirando el archivo.
pub fn find_root_candidates(root: &Path) -> Vec<String> {
    fn rec(dir: &Path, rel: &str, nivel: u32, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entradas: Vec<_> = rd.flatten().collect();
        entradas.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for e in entradas {
            let name = e.file_name().to_string_lossy().to_string();
            if nombre_oculto(&name) {
                continue;
            }
            let path = e.path();
            let rel_hijo = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if path.is_dir() {
                if nivel < 2 && name != "figuras-cache" {
                    rec(&path, &rel_hijo, nivel + 1, out);
                }
            } else if name.to_lowercase().ends_with(".tex") {
                if let Some(c) = cabecera(&path) {
                    if lineas_utiles(&c).any(|l| l.starts_with("\\documentclass")) {
                        out.push(rel_hijo);
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    rec(root, "", 0, &mut out);
    out
}

fn suggest(root: &Path, candidatas: &[String]) -> Option<String> {
    if candidatas.len() == 1 {
        return candidatas.first().cloned();
    }
    let con_documento: Vec<&String> = candidatas
        .iter()
        .filter(|c| {
            cabecera(&root.join(c)).is_some_and(|t| lineas_utiles(&t).any(|l| l.starts_with("\\begin{document}")))
        })
        .collect();
    (con_documento.len() == 1).then(|| con_documento[0].clone())
}
