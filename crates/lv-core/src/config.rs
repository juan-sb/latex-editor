//! `latexviewer.json` (versionado, del proyecto) y `.lv/state.json` (de esta máquina). Ver 4.1 del plan.
//!
//! Los dos archivos conservan los campos que esta versión no conoce (`extra`): un `latexviewer.json` escrito por otra
//! versión de la app, o con campos de fases que todavía no existen (`figureCache`, `export`), no se pierde al guardarlo.

use crate::error::{Error, Result};
use crate::fsio;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

pub const CONFIG_FILE: &str = "latexviewer.json";
pub const STATE_FILE: &str = ".lv/state.json";

pub const ENGINES: [&str; 3] = ["pdflatex", "xelatex", "lualatex"];

fn engine_por_defecto() -> String {
    "pdflatex".into()
}

fn verdadero() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PartsCfg {
    /// Comandos que delimitan una parte (`include` por defecto; el libro agrega `Capitulo`).
    #[serde(default = "comandos_por_defecto")]
    pub commands: Vec<String>,
}

pub fn comandos_por_defecto() -> Vec<String> {
    vec!["include".into()]
}

impl Default for PartsCfg {
    fn default() -> Self {
        PartsCfg { commands: comandos_por_defecto() }
    }
}

/// Macros que el driver define (vacías) antes de cargar la raíz, según el perfil.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlagsCfg {
    #[serde(default)]
    pub partial: Vec<String>,
    #[serde(default)]
    pub externalize: Vec<String>,
    #[serde(default)]
    pub figure_list: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct VariableCfg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// Qué partes entran en el perfil.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PartsSel {
    /// Las que el usuario tiene tildadas (`.lv/state.json`).
    Selection,
    /// Todas (sin `\includeonly`).
    #[default]
    All,
    /// Una sola, la que pide quien lanza el build (exportación, F7).
    One,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCfg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Define las macros de `flags.partial` y `\lvParcial`.
    #[serde(default)]
    pub partial: bool,
    /// Define las macros de `flags.externalize` y compila con `-shell-escape`.
    #[serde(default)]
    pub externalize: bool,
    /// Con `externalize`: el perfil sólo CONSUME el cache de figuras (`external/mode=graphics if exists`) y compila sin
    /// `-shell-escape`: pgf no lanza ninguna subcompilación, ni siquiera la de una figura nueva (la que no esté se dibuja en el
    /// lugar). Esa modalidad no mira el md5, así que antes de cada build la app cocina lo que falte (spike S5).
    #[serde(default)]
    pub cache_only: bool,
    #[serde(default)]
    pub parts: PartsSel,
    /// Borra los auxiliares del perfil antes de compilar (el completo del libro: referencias e índice desde cero).
    #[serde(default)]
    pub clean_before: bool,
    /// Si puede ser el perfil que compila el guardado. Un completo de un minuto en cada Ctrl+S no sirve (4.1 del plan).
    #[serde(default = "verdadero")]
    pub auto_compile: bool,
    #[serde(default)]
    pub hidden: bool,
    /// `\PassOptionsToPackage{draft}{graphicx}`: imágenes como cuadros, para proyectos con muchas.
    #[serde(default)]
    pub draft_images: bool,
}

impl Default for ProfileCfg {
    fn default() -> Self {
        ProfileCfg {
            label: None,
            partial: false,
            externalize: false,
            cache_only: false,
            parts: PartsSel::All,
            clean_before: false,
            auto_compile: true,
            hidden: false,
            draft_images: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PublishCfg {
    /// Relativa a la raíz del proyecto; puede salir de ella (`../PDF`): es una decisión explícita del proyecto.
    pub dir: String,
    /// Nombre del PDF publicado por perfil.
    #[serde(default)]
    pub names: IndexMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub root: String,
    #[serde(default = "engine_por_defecto")]
    pub engine: String,
    #[serde(default)]
    pub parts: PartsCfg,
    #[serde(default)]
    pub flags: FlagsCfg,
    /// Se lee en F6; hasta entonces sólo se conserva (y `dir` dice dónde están los `.md5` que hay que mover).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figure_cache: Option<Value>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub variables: IndexMap<String, VariableCfg>,
    #[serde(default)]
    pub profiles: IndexMap<String, ProfileCfg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish: Option<PublishCfg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Nombre de macro de TeX que se puede escribir como `\def\Nombre`.
pub fn macro_valida(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphabetic() || c == '@')
}

pub fn perfil_valido(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl ProjectConfig {
    pub fn validate(&self) -> Result<()> {
        let mal = |m: String| Err(Error::Other(format!("{CONFIG_FILE}: {m}")));
        if self.root.trim().is_empty() {
            return mal("falta `root`".into());
        }
        if !ENGINES.contains(&self.engine.as_str()) {
            return mal(format!("`engine` {:?} no es válido (pdflatex, xelatex o lualatex)", self.engine));
        }
        if self.profiles.is_empty() {
            return mal("no hay ningún perfil en `profiles`".into());
        }
        for id in self.profiles.keys() {
            if !perfil_valido(id) {
                return mal(format!("el perfil {id:?} no es válido (ASCII, sin espacios: es el nombre del driver)"));
            }
        }
        for m in self.flags.partial.iter().chain(&self.flags.externalize).chain(&self.flags.figure_list).chain(self.variables.keys()) {
            if !macro_valida(m) {
                return mal(format!("{m:?} no sirve como nombre de macro (sólo letras)"));
            }
        }
        for c in &self.parts.commands {
            if !c.chars().all(|c| c.is_ascii_alphabetic()) || c.is_empty() {
                return mal(format!("el comando de parte {c:?} no es válido"));
            }
        }
        Ok(())
    }

    /// Carpeta del cache de figuras (donde van los `.md5`), `figuras-cache` si el proyecto no dice otra cosa.
    pub fn figure_dir(&self) -> String {
        self.figure_cache
            .as_ref()
            .and_then(|v| v.get("dir"))
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty() && !d.starts_with('/') && !d.contains("..") && !d.contains(':'))
            .map(|d| d.replace('\\', "/").trim_matches('/').to_string())
            .unwrap_or_else(|| "figuras-cache".into())
    }

    pub fn visible_profiles(&self) -> impl Iterator<Item = (&String, &ProfileCfg)> {
        self.profiles.iter().filter(|(_, p)| !p.hidden)
    }
}

/// Configuración que se arma sin `latexviewer.json`. Si el proyecto tiene partes se ofrecen los tres perfiles del
/// plan; si no (un artículo), alcanza con uno. El completo no es candidato a auto-compilar cuando hay otros: sería un
/// build de minutos en cada guardado.
pub fn infer_config(root_file: &str, hay_partes: bool) -> ProjectConfig {
    let mut profiles = IndexMap::new();
    if hay_partes {
        profiles.insert(
            "parcial".to_string(),
            ProfileCfg { label: Some("Partes elegidas".into()), partial: true, parts: PartsSel::Selection, ..Default::default() },
        );
        profiles.insert(
            "rapido".to_string(),
            ProfileCfg { label: Some("Todas las partes".into()), partial: true, parts: PartsSel::All, ..Default::default() },
        );
        profiles.insert(
            "completo".to_string(),
            ProfileCfg { label: Some("Documento completo".into()), auto_compile: false, ..Default::default() },
        );
    } else {
        profiles.insert("completo".to_string(), ProfileCfg { label: Some("Documento".into()), ..Default::default() });
    }
    ProjectConfig {
        root: root_file.to_string(),
        engine: engine_por_defecto(),
        parts: PartsCfg::default(),
        flags: FlagsCfg::default(),
        figure_cache: None,
        variables: IndexMap::new(),
        profiles,
        publish: None,
        export: None,
        extra: Map::new(),
    }
}

/// `None` si no existe. Un JSON roto o inválido es un error con el nombre del archivo: no se pisa en silencio.
pub fn read_config(root: &Path) -> Result<Option<ProjectConfig>> {
    let path = root.join(CONFIG_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Io(format!("{CONFIG_FILE}: {e}"))),
    };
    let sin_bom = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let cfg: ProjectConfig = serde_json::from_slice(sin_bom).map_err(|e| Error::Other(format!("{CONFIG_FILE}: {e}")))?;
    cfg.validate()?;
    Ok(Some(cfg))
}

/// JSON con sangría de 2 espacios y salto final, UTF-8 sin BOM. Escritura atómica.
pub fn save_config(root: &Path, cfg: &ProjectConfig) -> Result<()> {
    cfg.validate()?;
    let mut texto = serde_json::to_string_pretty(cfg).map_err(|e| Error::Other(e.to_string()))?;
    texto.push('\n');
    let destino = root.join(CONFIG_FILE);
    if std::fs::read(&destino).is_ok_and(|b| b == texto.as_bytes()) {
        return Ok(());
    }
    fsio::escribir_atomico(&destino, texto.as_bytes()).map_err(|e| Error::Io(format!("{CONFIG_FILE}: {e}")))
}

// --- estado de esta máquina ------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutoCompile {
    /// Al guardar (por defecto).
    #[default]
    Save,
    /// Al dejar de tipear `idle_ms` (con autoguardado).
    Idle,
    Manual,
}

/// Qué hacer cuando se guarda un archivo que el perfil activo no usa (5.3 del plan).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutsideSave {
    /// Aviso con un botón "Compilar esta parte".
    #[default]
    Warn,
    /// Cambia la selección a esa parte y compila.
    Switch,
    /// Compila igual el perfil activo.
    Build,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    /// Raíz elegida en esta máquina; pisa a la de `latexviewer.json` (que puede no existir todavía).
    pub root: Option<String>,
    pub active_profile: Option<String>,
    /// Nombres de las partes tildadas, tal como las lleva `\includeonly`.
    pub selection: Vec<String>,
    pub variables: BTreeMap<String, String>,
    pub auto_compile: AutoCompile,
    pub idle_ms: u64,
    pub outside_save: OutsideSave,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for State {
    fn default() -> Self {
        State {
            root: None,
            active_profile: None,
            selection: vec![],
            variables: BTreeMap::new(),
            auto_compile: AutoCompile::Save,
            idle_ms: 1500,
            outside_save: OutsideSave::Warn,
            extra: Map::new(),
        }
    }
}

/// Cambios parciales al estado (lo que manda la interfaz).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatePatch {
    pub active_profile: Option<String>,
    pub selection: Option<Vec<String>>,
    pub variables: Option<BTreeMap<String, String>>,
    pub auto_compile: Option<AutoCompile>,
    pub idle_ms: Option<u64>,
    pub outside_save: Option<OutsideSave>,
}

/// Un estado ilegible no es un error: es de esta máquina y se rearma con los valores por defecto.
pub fn read_state(root: &Path) -> State {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<State>(b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&b)).ok())
        .unwrap_or_default()
}

pub fn write_state(root: &Path, st: &State) -> Result<()> {
    let mut texto = serde_json::to_string_pretty(st).map_err(|e| Error::Other(e.to_string()))?;
    texto.push('\n');
    crate::build::write_if_changed(&root.join(STATE_FILE), &texto)?;
    Ok(())
}

/// El plan dice que la app agrega `.lv/` al `.gitignore`. Sólo si el proyecto es un repositorio (hay `.git` o ya hay un
/// `.gitignore`), y conservando el salto de línea del archivo. Devuelve si escribió.
pub fn ensure_gitignore(root: &Path) -> Result<bool> {
    let path = root.join(".gitignore");
    let actual = std::fs::read(&path).ok();
    if actual.is_none() && !root.join(".git").exists() {
        return Ok(false);
    }
    let bytes = actual.unwrap_or_default();
    let texto = String::from_utf8_lossy(&bytes);
    if texto.lines().any(|l| matches!(l.trim(), ".lv" | ".lv/" | "/.lv" | "/.lv/")) {
        return Ok(false);
    }
    let eol = if texto.contains("\r\n") { "\r\n" } else { "\n" };
    let mut nuevo = bytes.clone();
    if !nuevo.is_empty() && !nuevo.ends_with(b"\n") {
        nuevo.extend_from_slice(eol.as_bytes());
    }
    nuevo.extend_from_slice(format!(".lv/{eol}").as_bytes());
    fsio::escribir_atomico(&path, &nuevo).map_err(|e| Error::Io(format!(".gitignore: {e}")))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRO: &str = r#"{
      "root": "Funciones de Aproximación.tex",
      "parts": { "commands": ["include", "Capitulo"] },
      "flags": { "partial": ["CompilacionReducida"], "externalize": ["TikzExternalizar"], "figureList": ["TikzListaYMake"] },
      "figureCache": { "mode": "project", "dir": "figuras-cache" },
      "variables": { "OpcionPie": { "label": "Pie", "choices": ["completo", "autor"], "default": "completo" } },
      "profiles": {
        "parcial": { "partial": true, "externalize": true, "parts": "selection" },
        "rapido": { "partial": true, "externalize": true, "parts": "all" },
        "completo": { "cleanBefore": true, "autoCompile": false }
      },
      "publish": { "dir": "../PDF", "names": { "completo": "Libro.pdf" } },
      "campoFuturo": { "a": 1 }
    }"#;

    #[test]
    fn lee_el_ejemplo_del_plan_y_conserva_lo_que_no_conoce() {
        let cfg: ProjectConfig = serde_json::from_str(LIBRO).unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.profiles.keys().collect::<Vec<_>>(), ["parcial", "rapido", "completo"], "el orden de los perfiles es el del archivo");
        assert_eq!(cfg.profiles["parcial"].parts, PartsSel::Selection);
        assert!(cfg.profiles["completo"].clean_before && !cfg.profiles["completo"].auto_compile);
        assert!(cfg.profiles["rapido"].auto_compile, "auto_compile vale true si no se dice");
        assert_eq!(cfg.flags.figure_list, ["TikzListaYMake"]);
        assert_eq!(cfg.figure_dir(), "figuras-cache");
        assert_eq!(cfg.extra["campoFuturo"]["a"], 1);
        // Ida y vuelta: no se pierde ni el campo futuro ni el cache de figuras.
        let otra: ProjectConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(cfg, otra);
    }

    #[test]
    fn rechaza_configuraciones_que_romperian_el_driver() {
        let mut cfg: ProjectConfig = serde_json::from_str(LIBRO).unwrap();
        cfg.engine = "word".into();
        assert!(cfg.validate().is_err());
        let mut cfg: ProjectConfig = serde_json::from_str(LIBRO).unwrap();
        cfg.flags.partial.push("con espacio".into());
        assert!(cfg.validate().is_err());
        let mut cfg: ProjectConfig = serde_json::from_str(LIBRO).unwrap();
        cfg.profiles.insert("ñandú".into(), ProfileCfg::default());
        assert!(cfg.validate().is_err(), "el perfil es el jobname: ASCII");
        let mut cfg: ProjectConfig = serde_json::from_str(LIBRO).unwrap();
        cfg.profiles.clear();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn el_dir_de_figuras_no_puede_salir_de_la_raiz() {
        let mut cfg = infer_config("main.tex", false);
        assert_eq!(cfg.figure_dir(), "figuras-cache");
        for malo in ["../x", "/abs", "C:/x", ""] {
            cfg.figure_cache = Some(serde_json::json!({ "dir": malo }));
            assert_eq!(cfg.figure_dir(), "figuras-cache", "{malo:?}");
        }
        cfg.figure_cache = Some(serde_json::json!({ "dir": "img\\cache/" }));
        assert_eq!(cfg.figure_dir(), "img/cache");
    }

    #[test]
    fn la_inferencia_ofrece_tres_perfiles_con_partes_y_uno_sin_ellas() {
        let con = infer_config("main.tex", true);
        assert_eq!(con.profiles.keys().collect::<Vec<_>>(), ["parcial", "rapido", "completo"]);
        assert!(!con.profiles["completo"].auto_compile);
        con.validate().unwrap();
        let sin = infer_config("main.tex", false);
        assert_eq!(sin.profiles.keys().collect::<Vec<_>>(), ["completo"]);
        assert!(sin.profiles["completo"].auto_compile, "con un solo perfil, guardar tiene que compilarlo");
    }

    #[test]
    fn el_estado_viejo_o_roto_no_impide_abrir() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_state(d.path()), State::default());
        std::fs::create_dir_all(d.path().join(".lv")).unwrap();
        std::fs::write(d.path().join(STATE_FILE), "{ esto no es json").unwrap();
        assert_eq!(read_state(d.path()), State::default());
        std::fs::write(d.path().join(STATE_FILE), r#"{"activeProfile":"parcial","autoCompile":"idle","algoNuevo":true}"#).unwrap();
        let s = read_state(d.path());
        assert_eq!(s.active_profile.as_deref(), Some("parcial"));
        assert_eq!(s.auto_compile, AutoCompile::Idle);
        assert_eq!(s.idle_ms, 1500, "lo que falta toma el valor por defecto");
        write_state(d.path(), &s).unwrap();
        assert!(std::fs::read_to_string(d.path().join(STATE_FILE)).unwrap().contains("algoNuevo"));
    }

    #[test]
    fn config_con_bom_y_guardado_idempotente() {
        let d = tempfile::tempdir().unwrap();
        assert!(read_config(d.path()).unwrap().is_none());
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(LIBRO.as_bytes());
        std::fs::write(d.path().join(CONFIG_FILE), &bytes).unwrap();
        let cfg = read_config(d.path()).unwrap().unwrap();
        save_config(d.path(), &cfg).unwrap();
        let guardado = std::fs::read(d.path().join(CONFIG_FILE)).unwrap();
        assert!(!guardado.starts_with(&[0xEF]), "lo que escribe la app va sin BOM");
        assert!(guardado.ends_with(b"}\n"));
        let m1 = std::fs::metadata(d.path().join(CONFIG_FILE)).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        save_config(d.path(), &cfg).unwrap();
        assert_eq!(std::fs::metadata(d.path().join(CONFIG_FILE)).unwrap().modified().unwrap(), m1, "igual contenido: no se toca");
        std::fs::write(d.path().join(CONFIG_FILE), "{ roto").unwrap();
        let e = read_config(d.path()).unwrap_err().to_string();
        assert!(e.contains(CONFIG_FILE), "{e}");
    }

    #[test]
    fn gitignore_se_completa_sin_cambiar_el_eol_ni_duplicar() {
        let d = tempfile::tempdir().unwrap();
        assert!(!ensure_gitignore(d.path()).unwrap(), "sin repositorio no se crea nada");
        assert!(!d.path().join(".gitignore").exists());
        std::fs::create_dir(d.path().join(".git")).unwrap();
        assert!(ensure_gitignore(d.path()).unwrap());
        assert_eq!(std::fs::read(d.path().join(".gitignore")).unwrap(), b".lv/\n");
        std::fs::write(d.path().join(".gitignore"), b"*.aux\r\n*.log").unwrap();
        assert!(ensure_gitignore(d.path()).unwrap());
        assert_eq!(std::fs::read(d.path().join(".gitignore")).unwrap(), b"*.aux\r\n*.log\r\n.lv/\r\n");
        assert!(!ensure_gitignore(d.path()).unwrap(), "ya estaba");
        std::fs::write(d.path().join(".gitignore"), b"/.lv\n").unwrap();
        assert!(!ensure_gitignore(d.path()).unwrap());
    }
}
