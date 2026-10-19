//! Un proyecto abierto: raíz, configuración, estado, índice y el motor de compilación con su cola.
//!
//! Es lo que la capa de Tauri expone: la interfaz le pide "compilar el perfil X" y acá se resuelve qué lleva el driver,
//! qué auxiliares hay que sembrar o limpiar, y qué hacer si ya hay un build corriendo.
//!
//! **Cola (5.6 del plan).** Un solo build activo por proyecto. Un pedido mientras corre otro queda *pendiente* y corre una
//! sola vez cuando termine (los pedidos se coalescen: gana el último). Guardar no mata el build en curso; sólo cancelar,
//! explícitamente, lo hace, y cancelar descarta el pendiente.
//!
//! **Reparación (5.5).** Si el build falla con el error de un `.aux` truncado, se borran los auxiliares del perfil y se
//! reintenta una sola vez. El primer `Finished` no llega a la interfaz: ve un solo build con `repaired: true`.

use crate::auxiliares as aux;
use crate::build::{render_driver_spec, BuildEvent, Builder, DriverSpec, RunSpec, Sink};
use crate::config::{self, comandos_por_defecto, infer_config, PartsSel, ProjectConfig, State, StatePatch};
use crate::error::{Error, Result};
use crate::fsio;
use crate::graph::{Affects, ProjectIndex};
use crate::logparse::{self, Problem};
use crate::project;
use crate::synctex::{Rect, Synctex};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// --- lo que ve la interfaz ----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartView {
    pub name: String,
    pub file: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub label: String,
    pub partial: bool,
    pub externalize: bool,
    pub parts: PartsSel,
    pub clean_before: bool,
    pub auto_compile: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableView {
    pub name: String,
    pub label: String,
    pub choices: Vec<String>,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub engine: String,
    pub profiles: Vec<ProfileView>,
    pub variables: Vec<VariableView>,
    /// Dónde se publica, si el proyecto lo dice.
    pub publish_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub name: String,
    pub root: String,
    pub candidates: Vec<String>,
    pub root_file: Option<String>,
    /// `latexviewer.json` existe en disco. Si no, la configuración es la inferida y la interfaz ofrece guardarla.
    pub config_saved: bool,
    /// El `latexviewer.json` que hay no se pudo leer: se usa la configuración inferida y no se pisa el archivo solo.
    pub config_error: Option<String>,
    pub config: Option<ConfigView>,
    pub state: State,
    pub parts: Vec<PartView>,
    pub index_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BuildAck {
    Started { id: u64 },
    Queued,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// La parte a la que pertenece el archivo (ella misma, o la que la trae), si es de alguna.
    pub part: Option<String>,
    /// `yes`, `other_part` o `unrelated`, respecto del perfil activo y su selección.
    pub affects: String,
    /// El perfil activo puede compilar al guardar.
    pub profile_auto: bool,
    /// Las partes del proyecto cambiaron desde la última vez (por ejemplo, se agregó un `\Capitulo`).
    pub parts_changed: bool,
}

/// Del cursor al PDF: en qué perfil, qué PDF, y las cajas de línea (en bp desde arriba a la izquierda).
#[derive(Debug, Clone, Serialize)]
pub struct SyncForward {
    pub perfil: String,
    pub pdf: String,
    pub page: u32,
    pub rects: Vec<Rect>,
    pub line_used: u32,
}

/// Del PDF al código. `file` es `None` si el texto viene de un archivo del sistema o del driver.
#[derive(Debug, Clone, Serialize)]
pub struct SyncInverse {
    pub file: Option<String>,
    pub line: u32,
    pub inside: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Published {
    pub pdf: String,
    pub synctex: Option<String>,
}

// --- la sesión -----------------------------------------------------------------------------------------------------------

struct Datos {
    root_file: Option<String>,
    config: Option<ProjectConfig>,
    config_saved: bool,
    config_error: Option<String>,
    state: State,
    index: Option<ProjectIndex>,
}

pub struct Session {
    pub root: PathBuf,
    name: String,
    candidates: Vec<String>,
    sink: Sink,
    builder: Builder,
    datos: Mutex<Datos>,
    pendiente: Mutex<Option<String>>,
    /// Las partes que la interfaz vio por última vez (`view`/`refresh`): `file_info` avisa cuando ya no coinciden.
    partes_vistas: Mutex<Vec<String>>,
    /// Los problemas del último build de cada perfil (`logparse`), para que la interfaz los pida sin releer el log.
    problemas: Mutex<std::collections::HashMap<String, Vec<Problem>>>,
    /// El `.synctex.gz` cargado de cada perfil, con el mtime con el que se leyó: un build nuevo lo invalida.
    synctex: Mutex<std::collections::HashMap<String, (std::time::SystemTime, Arc<Synctex>)>>,
}

/// Todo lo que hace falta para lanzar un build, resuelto bajo el candado de los datos.
struct Plan {
    spec: RunSpec,
    cache_dir: String,
    clean: bool,
    /// Partes excluidas y perfiles de donde sembrarlas (sólo si el perfil usa `\includeonly`).
    seed: Option<(Vec<String>, Vec<String>)>,
    dirs: BTreeSet<String>,
}

fn otro(m: impl Into<String>) -> Error {
    Error::Other(m.into())
}

fn perfil_por_defecto(cfg: &ProjectConfig) -> String {
    cfg.visible_profiles()
        .find(|(_, p)| p.auto_compile)
        .or_else(|| cfg.visible_profiles().next())
        .map(|(id, _)| id.clone())
        .or_else(|| cfg.profiles.keys().next().cloned())
        .unwrap_or_else(|| "completo".into())
}

impl Session {
    pub fn open(path: &Path, sink: Sink) -> Result<Arc<Session>> {
        Self::open_with(path, sink, Builder::new())
    }

    /// Los tests le pasan un `Builder` que corre un script en lugar de latexmk.
    pub fn open_with(path: &Path, sink: Sink, builder: Builder) -> Result<Arc<Session>> {
        let p = project::open_project(path)?;
        let (config, config_error) = match config::read_config(&p.root) {
            Ok(c) => (c, None),
            Err(e) => (None, Some(e.to_string())),
        };
        let state = config::read_state(&p.root);
        let existe = |rel: &String| fsio::resolver(&p.root, rel, false).is_ok_and(|r| r.is_file());
        let root_file = state
            .root
            .clone()
            .filter(existe)
            .or_else(|| config.as_ref().map(|c| c.root.clone()).filter(existe))
            .or_else(|| p.info.suggested.clone());
        let s = Session {
            root: p.root.clone(),
            name: p.info.name.clone(),
            candidates: p.info.candidates.clone(),
            sink,
            builder,
            datos: Mutex::new(Datos { root_file, config_saved: config.is_some(), config, config_error, state, index: None }),
            pendiente: Mutex::new(None),
            partes_vistas: Mutex::new(vec![]),
            problemas: Mutex::new(Default::default()),
            synctex: Mutex::new(Default::default()),
        };
        {
            let mut d = s.datos.lock().map_err(|_| otro("estado envenenado"))?;
            s.recalcular(&mut d);
            *s.partes_vistas.lock().unwrap() = d.index.as_ref().map(|i| i.part_names()).unwrap_or_default();
        }
        Ok(Arc::new(s))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Datos>> {
        self.datos.lock().map_err(|_| otro("estado de la sesión envenenado"))
    }

    /// Rearma el índice y lo que depende de él (configuración inferida, perfil activo, selección).
    fn recalcular(&self, d: &mut Datos) {
        let Some(rf) = d.root_file.clone() else {
            d.index = None;
            return;
        };
        let comandos = d.config.as_ref().map(|c| c.parts.commands.clone()).unwrap_or_else(comandos_por_defecto);
        let ix = ProjectIndex::build(&self.root, &rf, &comandos);
        let hay_partes = !ix.parts.is_empty();
        match &mut d.config {
            None => d.config = Some(infer_config(&rf, hay_partes)),
            Some(c) if !d.config_saved => {
                // Configuración inferida: sigue a lo que hay en el proyecto.
                if hay_partes != (c.profiles.len() > 1) {
                    *c = infer_config(&rf, hay_partes);
                } else {
                    c.root = rf.clone();
                }
            }
            Some(_) => {}
        }
        let cfg = d.config.as_ref().expect("recién asegurada");
        if !d.state.active_profile.as_ref().is_some_and(|p| cfg.profiles.contains_key(p)) {
            d.state.active_profile = Some(perfil_por_defecto(cfg));
        }
        let nombres = ix.part_names();
        d.state.selection.retain(|s| nombres.contains(s));
        if d.state.selection.is_empty() {
            if let Some(primera) = nombres.first() {
                d.state.selection.push(primera.clone());
            }
        }
        d.index = Some(ix);
    }

    fn vista(&self, d: &Datos) -> ProjectView {
        if let (Some(ix), Ok(mut vistas)) = (&d.index, self.partes_vistas.lock()) {
            *vistas = ix.part_names();
        }
        let config = d.config.as_ref().map(|c| ConfigView {
            engine: c.engine.clone(),
            profiles: c
                .profiles
                .iter()
                .map(|(id, p)| ProfileView {
                    id: id.clone(),
                    label: p.label.clone().unwrap_or_else(|| id.clone()),
                    partial: p.partial,
                    externalize: p.externalize,
                    parts: p.parts,
                    clean_before: p.clean_before,
                    auto_compile: p.auto_compile,
                    hidden: p.hidden,
                })
                .collect(),
            variables: c
                .variables
                .iter()
                .map(|(n, v)| VariableView {
                    name: n.clone(),
                    label: v.label.clone().unwrap_or_else(|| n.clone()),
                    choices: v.choices.clone(),
                    default: v.default.clone(),
                })
                .collect(),
            publish_dir: c.publish.as_ref().map(|p| p.dir.clone()),
        });
        ProjectView {
            name: self.name.clone(),
            root: self.root.display().to_string(),
            candidates: self.candidates.clone(),
            root_file: d.root_file.clone(),
            config_saved: d.config_saved,
            config_error: d.config_error.clone(),
            config,
            state: d.state.clone(),
            parts: d
                .index
                .as_ref()
                .map(|ix| {
                    ix.parts.iter().map(|p| PartView { name: p.name.clone(), file: p.file.clone(), command: p.command.clone() }).collect()
                })
                .unwrap_or_default(),
            index_ms: d.index.as_ref().map(|i| i.scan_ms).unwrap_or(0),
        }
    }

    pub fn view(&self) -> Result<ProjectView> {
        let d = self.lock()?;
        Ok(self.vista(&d))
    }

    /// Vuelve a leer el proyecto del disco (índice incluido) y devuelve la vista nueva.
    pub fn refresh(&self) -> Result<ProjectView> {
        let mut d = self.lock()?;
        self.recalcular(&mut d);
        Ok(self.vista(&d))
    }

    pub fn set_root(&self, rel: &str) -> Result<ProjectView> {
        if self.builder.is_running() {
            return Err(Error::Busy);
        }
        let ruta = fsio::resolver(&self.root, rel, false)?;
        if !ruta.is_file() {
            return Err(Error::NotFound(rel.to_string()));
        }
        let mut d = self.lock()?;
        d.root_file = Some(rel.to_string());
        d.state.root = Some(rel.to_string());
        if !d.config_saved {
            d.config = None; // se vuelve a inferir para la raíz nueva
        }
        self.recalcular(&mut d);
        self.guardar_estado(&d);
        Ok(self.vista(&d))
    }

    fn guardar_estado(&self, d: &Datos) {
        // El estado es de esta máquina y no impide trabajar: si no se puede escribir (carpeta de sólo lectura), la
        // sesión sigue con lo que tiene en memoria.
        let _ = config::ensure_gitignore(&self.root);
        let _ = config::write_state(&self.root, &d.state);
    }

    pub fn set_state(&self, patch: StatePatch) -> Result<State> {
        let mut d = self.lock()?;
        let cfg = d.config.clone().ok_or_else(|| otro("elegí primero la raíz del documento"))?;
        let nombres = d.index.as_ref().map(|i| i.part_names()).unwrap_or_default();
        if let Some(p) = &patch.active_profile {
            if !cfg.profiles.contains_key(p) {
                return Err(otro(format!("no existe el perfil {p:?}")));
            }
        }
        if let Some(sel) = &patch.selection {
            if let Some(mala) = sel.iter().find(|s| !nombres.contains(s)) {
                return Err(otro(format!("{mala:?} no es una parte del proyecto")));
            }
        }
        if let Some(vars) = &patch.variables {
            for (k, v) in vars {
                let Some(def) = cfg.variables.get(k) else { return Err(otro(format!("no existe la variable {k:?}"))) };
                if !def.choices.is_empty() && !def.choices.contains(v) {
                    return Err(otro(format!("{v:?} no es una opción de {k}")));
                }
            }
        }
        let s = &mut d.state;
        if let Some(p) = patch.active_profile {
            s.active_profile = Some(p);
        }
        if let Some(sel) = patch.selection {
            s.selection = sel;
        }
        if let Some(v) = patch.variables {
            s.variables.extend(v);
        }
        if let Some(a) = patch.auto_compile {
            s.auto_compile = a;
        }
        if let Some(ms) = patch.idle_ms {
            s.idle_ms = ms.clamp(300, 60_000);
        }
        if let Some(o) = patch.outside_save {
            s.outside_save = o;
        }
        let nuevo = d.state.clone();
        self.guardar_estado(&d);
        Ok(nuevo)
    }

    /// Escribe `latexviewer.json` con la configuración actual (la inferida, si no había). Es explícito: el archivo es del
    /// proyecto y va a git.
    pub fn save_config(&self) -> Result<ProjectView> {
        let mut d = self.lock()?;
        let rf = d.root_file.clone().ok_or_else(|| otro("elegí primero la raíz del documento"))?;
        let mut cfg = d.config.clone().ok_or_else(|| otro("no hay configuración"))?;
        cfg.root = rf;
        config::save_config(&self.root, &cfg)?;
        d.config = Some(cfg);
        d.config_saved = true;
        d.config_error = None;
        Ok(self.vista(&d))
    }

    /// Qué pasa con `rel` respecto del perfil activo. Vuelve a indexar: se llama justo después de guardar.
    pub fn file_info(&self, rel: &str) -> Result<FileInfo> {
        let mut d = self.lock()?;
        let rf = d.root_file.clone().ok_or_else(|| otro("elegí primero la raíz del documento"))?;
        let comandos = d.config.as_ref().map(|c| c.parts.commands.clone()).unwrap_or_else(comandos_por_defecto);
        let ix = ProjectIndex::build(&self.root, &rf, &comandos);
        let parts_changed = self.partes_vistas.lock().is_ok_and(|v| *v != ix.part_names());
        let (part, affects, profile_auto) = {
            let cfg = d.config.as_ref().ok_or_else(|| otro("no hay configuración"))?;
            let perfil = d.state.active_profile.as_ref().and_then(|p| cfg.profiles.get(p));
            let seleccion = match perfil.map(|p| p.parts) {
                Some(PartsSel::Selection) => Some(d.state.selection.clone()),
                _ => None,
            };
            let afecta = match ix.affects(rel, seleccion.as_deref()) {
                Affects::Yes => "yes",
                Affects::OtherPart(_) => "other_part",
                Affects::Unrelated => "unrelated",
            };
            (ix.part_of(rel).map(|i| ix.parts[i].name.clone()), afecta, perfil.map_or(true, |p| p.auto_compile))
        };
        d.index = Some(ix);
        if parts_changed {
            // La selección puede haber quedado con partes que ya no existen.
            self.recalcular(&mut d);
        }
        Ok(FileInfo { part, affects: affects.into(), profile_auto, parts_changed })
    }

    // --- compilar -------------------------------------------------------------------------------------------------------

    fn plan(&self, perfil: &str, retry: bool) -> Result<Plan> {
        let mut d = self.lock()?;
        let rf = d.root_file.clone().ok_or_else(|| otro("elegí primero la raíz del documento"))?;
        let cfg = d.config.clone().ok_or_else(|| otro("no hay configuración"))?;
        let pc = cfg.profiles.get(perfil).ok_or_else(|| otro(format!("no existe el perfil {perfil:?}")))?.clone();
        // El índice se rehace acá: acaban de guardar y el pedido tiene que ver lo que hay en disco.
        let ix = ProjectIndex::build(&self.root, &rf, &cfg.parts.commands);
        let nombres = ix.part_names();
        let includeonly = match pc.parts {
            PartsSel::All => None,
            PartsSel::Selection => {
                if nombres.is_empty() {
                    return Err(otro(format!(
                        "el perfil {perfil:?} compila partes elegidas, pero el proyecto no tiene partes (¿falta `parts.commands` en latexviewer.json?)"
                    )));
                }
                let sel: Vec<String> = nombres.iter().filter(|n| d.state.selection.contains(n)).cloned().collect();
                if sel.is_empty() {
                    return Err(otro("elegí al menos una parte para compilar"));
                }
                Some(sel)
            }
            PartsSel::One => return Err(otro(format!("el perfil {perfil:?} es de exportación: se lanza desde Exportar"))),
        };
        let mut flags = Vec::new();
        if pc.partial {
            flags.extend(cfg.flags.partial.iter().cloned());
        }
        if pc.externalize {
            flags.extend(cfg.flags.externalize.iter().cloned());
        }
        let vars: Vec<(String, String)> = cfg
            .variables
            .iter()
            .filter_map(|(n, v)| d.state.variables.get(n).or(v.default.as_ref()).map(|x| (n.clone(), x.clone())))
            .collect();
        let seed = includeonly.as_ref().map(|sel| {
            (
                nombres.iter().filter(|n| !sel.contains(n)).cloned().collect::<Vec<_>>(),
                cfg.profiles.keys().filter(|p| p.as_str() != perfil).cloned().collect::<Vec<_>>(),
            )
        });
        let driver = render_driver_spec(&DriverSpec {
            perfil: perfil.to_string(),
            root_rel: rf.clone(),
            partial: pc.partial,
            flags,
            vars,
            includeonly,
            draft_images: pc.draft_images,
        })?;
        let dirs = ix.include_dirs(&cfg.parts.commands);
        d.index = Some(ix);
        Ok(Plan {
            spec: RunSpec { perfil: perfil.to_string(), root_rel: rf, driver, engine: cfg.engine.clone(), shell_escape: pc.externalize, retry },
            cache_dir: cfg.figure_dir(),
            clean: pc.clean_before,
            seed,
            dirs,
        })
    }

    /// Pide un build del perfil (el activo si no se dice). Si ya hay uno corriendo queda pendiente.
    pub fn request_build(self: &Arc<Self>, perfil: Option<&str>) -> Result<BuildAck> {
        let perfil = match perfil {
            Some(p) => p.to_string(),
            None => self.lock()?.state.active_profile.clone().ok_or_else(|| otro("no hay perfil activo"))?,
        };
        match self.lanzar(&perfil, false) {
            Ok(id) => Ok(BuildAck::Started { id }),
            Err(Error::Busy) => {
                *self.pendiente.lock().map_err(|_| otro("cola envenenada"))? = Some(perfil.clone());
                (self.sink)(BuildEvent::Queued { perfil });
                Ok(BuildAck::Queued)
            }
            Err(e) => Err(e),
        }
    }

    fn lanzar(self: &Arc<Self>, perfil: &str, retry: bool) -> Result<u64> {
        if self.builder.is_running() {
            return Err(Error::Busy);
        }
        let plan = self.plan(perfil, retry)?;
        let root = self.root.clone();
        let nombre = perfil.to_string();
        let antes = {
            let (plan, root, nombre) = (&plan, &root, &nombre);
            move || -> Result<()> {
                let _ = config::ensure_gitignore(root);
                // En el reintento ya se limpió; el completo se limpia siempre al empezar (`cleanBefore`).
                if plan.clean && !plan.spec.retry {
                    aux::clean_profile(root, nombre, &plan.cache_dir);
                }
                aux::ensure_include_dirs(root, nombre, &plan.dirs)?;
                if let Some((excluidas, fuentes)) = &plan.seed {
                    aux::seed(root, nombre, excluidas, fuentes)?;
                }
                // Sospechoso hasta que el build salga bien: sobrevive a un cierre brusco de la app.
                aux::mark_suspect(root, nombre)
            }
        };
        let sink = self.envolver(perfil.to_string(), plan.cache_dir.clone(), retry);
        self.builder.start_with(&self.root, &plan.spec, sink, &antes)
    }

    /// El sumidero del builder: deja pasar todo salvo el `Finished`, que primero pasa por `al_terminar`.
    fn envolver(self: &Arc<Self>, perfil: String, cache_dir: String, retry: bool) -> Sink {
        let me = self.clone();
        Arc::new(move |ev: BuildEvent| match ev {
            BuildEvent::Finished { .. } => me.al_terminar(ev, &perfil, &cache_dir, retry),
            otro => (me.sink)(otro),
        })
    }

    fn al_terminar(self: &Arc<Self>, ev: BuildEvent, perfil: &str, cache_dir: &str, retry: bool) {
        let mut ev = ev;
        let BuildEvent::Finished { id, ok, cancelled, truncated_aux, .. } = &ev else { return };
        let (id, ok, cancelled, truncated_aux) = (*id, *ok, *cancelled, *truncated_aux);
        aux::move_md5(&self.root, perfil, cache_dir);
        if ok {
            aux::clear_suspect(&self.root, perfil);
        }
        if !ok && truncated_aux && !cancelled && !retry {
            (self.sink)(BuildEvent::Log {
                id,
                text: format!("\n== .aux truncado en el perfil «{perfil}»: borro sus auxiliares y reintento una vez\n"),
            });
            let n = aux::clean_profile(&self.root, perfil, cache_dir);
            (self.sink)(BuildEvent::Log { id, text: format!("== {n} auxiliares borrados\n") });
            match self.lanzar(perfil, true) {
                Ok(_) => return, // el `Finished` de este intento no se informa: el del reintento lo reemplaza
                Err(e) => (self.sink)(BuildEvent::Error { message: format!("no se pudo reintentar: {e}") }),
            }
        }
        // Los problemas del log se leen una vez por build y viajan resumidos en el `Finished`; la lista la pide la interfaz.
        let encontrados = logparse::problems_of_profile(&self.root, perfil);
        if let BuildEvent::Finished { errors, warnings, badboxes, .. } = &mut ev {
            let c = logparse::count(&encontrados);
            (*errors, *warnings, *badboxes) = (c.errors, c.warnings, c.badboxes);
        }
        if let Ok(mut m) = self.problemas.lock() {
            m.insert(perfil.to_string(), encontrados);
        }
        (self.sink)(ev);
        self.correr_pendiente();
    }

    /// Los problemas del último build del perfil. Si todavía no se leyeron (la app recién abrió el proyecto), se leen del log.
    pub fn problems(&self, perfil: &str) -> Vec<Problem> {
        if let Some(p) = self.problemas.lock().ok().and_then(|m| m.get(perfil).cloned()) {
            return p;
        }
        logparse::problems_of_profile(&self.root, perfil)
    }

    fn correr_pendiente(self: &Arc<Self>) {
        let p = self.pendiente.lock().ok().and_then(|mut g| g.take());
        if let Some(perfil) = p {
            if let Err(e) = self.lanzar(&perfil, false) {
                (self.sink)(BuildEvent::Error { message: format!("no se pudo lanzar el build pendiente ({perfil}): {e}") });
            }
        }
    }

    pub fn is_building(&self) -> bool {
        self.builder.is_running()
    }

    /// Cancela el build en curso y descarta el pendiente. Devuelve si había un build corriendo.
    pub fn cancel(&self) -> bool {
        if let Ok(mut p) = self.pendiente.lock() {
            p.take();
        }
        self.builder.cancel()
    }

    // --- SyncTeX ----------------------------------------------------------------------------------------------------------

    fn synctex_gz(&self, perfil: &str) -> PathBuf {
        self.root.join(format!(".lv/build/{perfil}/lv-{perfil}.synctex.gz"))
    }

    /// Qué PDF usar para un archivo (6.4 del plan, la regla de `synctex_pdf.ps1` generalizada): el perfil de partes elegidas
    /// que incluye la parte del archivo, si tiene SyncTeX, aunque otro PDF sea más nuevo (el activo si hay varios); si no, el
    /// más reciente entre los perfiles que la contienen. Los perfiles ocultos y el de exportación no participan.
    pub fn elegir_pdf(&self, rel: &str) -> Result<Option<String>> {
        let d = self.lock()?;
        let cfg = d.config.as_ref().ok_or_else(|| otro("no hay configuración"))?;
        let parte = d.index.as_ref().and_then(|ix| ix.part_of(rel).map(|k| ix.parts[k].name.clone()));
        let mut candidatos: Vec<(String, PartsSel, std::time::SystemTime)> = Vec::new();
        for (id, p) in &cfg.profiles {
            if p.hidden || p.parts == PartsSel::One {
                continue;
            }
            let Ok(m) = std::fs::metadata(self.synctex_gz(id)).and_then(|m| m.modified()) else { continue };
            let contiene = match p.parts {
                PartsSel::All => true,
                // Un archivo que no es de ninguna parte (el preámbulo) está en todos los perfiles.
                PartsSel::Selection => parte.as_ref().is_none_or(|n| d.state.selection.contains(n)),
                PartsSel::One => false,
            };
            if contiene {
                candidatos.push((id.clone(), p.parts, m));
            }
        }
        let elegidos: Vec<&(String, PartsSel, std::time::SystemTime)> = candidatos.iter().filter(|c| c.1 == PartsSel::Selection).collect();
        if let Some(c) = elegidos.iter().find(|c| Some(&c.0) == d.state.active_profile.as_ref()).or(elegidos.first()) {
            return Ok(Some(c.0.clone()));
        }
        Ok(candidatos.iter().max_by_key(|c| c.2).map(|c| c.0.clone()))
    }

    /// El SyncTeX de un perfil, cargado una vez por build (47 ms con el libro completo) y cacheado por mtime.
    fn cargar_synctex(&self, perfil: &str) -> Result<Arc<Synctex>> {
        let ruta = self.synctex_gz(perfil);
        let mtime = std::fs::metadata(&ruta)
            .and_then(|m| m.modified())
            .map_err(|_| Error::NotFound(format!("el SyncTeX del perfil {perfil:?}: compilá antes")))?;
        if let Some((m, s)) = self.synctex.lock().map_err(|_| otro("cache envenenado"))?.get(perfil) {
            if *m == mtime {
                return Ok(s.clone());
            }
        }
        let s = Arc::new(Synctex::load(&ruta).map_err(|e| Error::Io(format!("{}: {e}", ruta.display())))?);
        self.synctex.lock().map_err(|_| otro("cache envenenado"))?.insert(perfil.to_string(), (mtime, s.clone()));
        Ok(s)
    }

    /// Del cursor al PDF. `Ok(None)` si el archivo no figura en el SyncTeX del PDF elegido (todavía no se compiló con él).
    pub fn synctex_forward(&self, rel: &str, line: u32) -> Result<Option<SyncForward>> {
        let Some(perfil) = self.elegir_pdf(rel)? else {
            return Err(otro("No hay ningún PDF con SyncTeX para este archivo: compilá antes."));
        };
        let sx = self.cargar_synctex(&perfil)?;
        let Some(tag) = sx.tag_of(&self.root, rel) else { return Ok(None) };
        Ok(sx.forward(tag, line).map(|f| SyncForward {
            pdf: crate::build::pdf_rel(&perfil),
            page: f.rects[0].page,
            rects: f.rects,
            line_used: f.line_used,
            perfil,
        }))
    }

    /// Del PDF al código. `(page, x, y)` en bp desde arriba a la izquierda.
    pub fn synctex_inverse(&self, perfil: &str, page: u32, x: f64, y: f64) -> Result<Option<SyncInverse>> {
        if !self.lock()?.config.as_ref().is_some_and(|c| c.profiles.contains_key(perfil)) {
            return Err(otro(format!("no existe el perfil {perfil:?}")));
        }
        let sx = self.cargar_synctex(perfil)?;
        Ok(sx.inverse(page, x, y).map(|i| SyncInverse { file: sx.rel_of_tag(&self.root, i.tag), line: i.line, inside: i.inside }))
    }

    // --- publicar ---------------------------------------------------------------------------------------------------------

    /// Copia el PDF del perfil (y su `.synctex.gz`) a `publish.dir` con el nombre configurado. Nunca se renombra el PDF
    /// de trabajo (fila 3 de la tabla de inspo): latexmk lo daría por desactualizado en cada guardado.
    pub fn publish(&self, perfil: &str) -> Result<Published> {
        let (cfg, rf) = {
            let d = self.lock()?;
            (d.config.clone().ok_or_else(|| otro("no hay configuración"))?, d.root_file.clone().unwrap_or_default())
        };
        let Some(pubcfg) = &cfg.publish else {
            return Err(otro("el proyecto no define `publish.dir` en latexviewer.json"));
        };
        if !cfg.profiles.contains_key(perfil) {
            return Err(otro(format!("no existe el perfil {perfil:?}")));
        }
        if aux::is_suspect(&self.root, perfil) {
            return Err(otro(format!("el último build de {perfil:?} no terminó bien: el PDF puede estar desactualizado. Compilá de nuevo antes de publicar")));
        }
        let origen = self.root.join(crate::build::pdf_rel(perfil));
        if !origen.is_file() {
            return Err(Error::NotFound(format!("el PDF de {perfil:?}: compilá antes de publicar")));
        }
        let stem = Path::new(&rf).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "documento".into());
        let nombre = pubcfg.names.get(perfil).cloned().unwrap_or_else(|| if perfil == "completo" { format!("{stem}.pdf") } else { format!("{stem} ({perfil}).pdf") });
        if nombre.contains(['/', '\\', ':']) || nombre.contains("..") || nombre.trim().is_empty() {
            return Err(Error::InvalidPath(format!("nombre de publicación {nombre:?}: tiene que ser un nombre de archivo")));
        }
        let nombre = if nombre.to_lowercase().ends_with(".pdf") { nombre } else { format!("{nombre}.pdf") };
        let dir = self.root.join(&pubcfg.dir);
        std::fs::create_dir_all(&dir).map_err(|e| Error::Io(format!("{}: {e}", dir.display())))?;
        let destino = dir.join(&nombre);
        let bytes = std::fs::read(&origen).map_err(|e| Error::Io(format!("{}: {e}", origen.display())))?;
        fsio::escribir_atomico(&destino, &bytes).map_err(|e| Error::Io(format!("{}: {e}", destino.display())))?;
        let gz_origen = origen.with_extension("synctex.gz");
        let synctex = if gz_origen.is_file() {
            let gz_destino = dir.join(format!("{}.synctex.gz", nombre.trim_end_matches(".pdf").trim_end_matches(".PDF")));
            let b = std::fs::read(&gz_origen).map_err(|e| Error::Io(format!("{}: {e}", gz_origen.display())))?;
            fsio::escribir_atomico(&gz_destino, &b).map_err(|e| Error::Io(format!("{}: {e}", gz_destino.display())))?;
            Some(gz_destino.display().to_string())
        } else {
            None
        };
        Ok(Published { pdf: destino.display().to_string(), synctex })
    }
}
