//! El cache de figuras como datos (sección 7 del plan): su configuración, el sello, lo que hay en la carpeta, la lista de
//! figuras del último listado (`.lv/figlist.json`), cuáles están pendientes y qué se puede limpiar. Sin procesos: el que
//! lanza TeX es `cocinero.rs`, y la verificación de lo que salió, `figures.rs`.
//!
//! Los nombres del cache son los de pgf: `<carpeta>/<sello>-<slug>-<n>` (el libro, con `\FigurasDe{slug}`) o, en el modo
//! `app`, los que arma el driver con el mismo esquema. El sello son los 6 primeros dígitos hex (mayúsculas) del md5 de los
//! `stampFiles`: cambiar un archivo de estilo cambia el nombre de todas las figuras, y como el cache queda indexado por
//! sello, deshacer el cambio devuelve las figuras de antes sin cocinar nada.

use crate::auxiliares::build_dir;
use crate::config::ProjectConfig;
use crate::error::{Error, Result};
use md5::{Digest, Md5};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

pub const FIGLIST_FILE: &str = ".lv/figlist.json";

// --- configuración -------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Modo {
    /// El proyecto ya trae su externalización (el libro, en `structure.tex`): la app calcula el sello, cocina y limpia.
    Project,
    /// La app inyecta la externalización en el driver de los proyectos que no la tienen.
    App,
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FigureCfg {
    pub modo: Modo,
    pub dir: String,
    pub stamp_files: Vec<String>,
    pub only_in_figure_env: bool,
    /// Subcompilaciones a la vez en la cocción.
    pub jobs: usize,
}

fn nucleos() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

fn ruta_relativa_valida(r: &str) -> bool {
    !r.is_empty() && !r.starts_with('/') && !r.contains("..") && !r.contains(':') && !r.contains('\\')
}

impl FigureCfg {
    /// Lee `figureCache` de `latexviewer.json`. Sin esa sección, el modo es `project` si algún perfil externaliza (el
    /// proyecto trae sus macros) y `off` si no: un artículo sin figuras externalizadas no necesita nada de esto.
    pub fn de(cfg: &ProjectConfig) -> FigureCfg {
        let v = cfg.figure_cache.as_ref();
        let texto = |k: &str| v.and_then(|v| v.get(k)).and_then(|x| x.as_str());
        let modo = match texto("mode") {
            Some("app") => Modo::App,
            Some("off") => Modo::Off,
            Some("project") => Modo::Project,
            _ if !cfg.flags.externalize.is_empty() || cfg.profiles.values().any(|p| p.externalize) => Modo::Project,
            _ => Modo::Off,
        };
        let stamp_files = v
            .and_then(|v| v.get("stampFiles"))
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.replace('\\', "/")).filter(|s| ruta_relativa_valida(s)).collect())
            .unwrap_or_default();
        let jobs = match v.and_then(|v| v.get("parallelJobs")) {
            Some(n) if n.is_u64() => (n.as_u64().unwrap_or(1) as usize).clamp(1, 64),
            _ => nucleos(),
        };
        FigureCfg {
            modo,
            dir: cfg.figure_dir(),
            stamp_files,
            only_in_figure_env: v.and_then(|v| v.get("onlyInFigureEnv")).and_then(|x| x.as_bool()).unwrap_or(true),
            jobs,
        }
    }

    /// Un proyecto con sello en los nombres: sólo ahí el disparo automático tiene sentido (los nombres de pgf sin sello,
    /// `<jobname>-figure0`, no cambian con el estilo).
    pub fn usa_sello(&self) -> bool {
        !self.stamp_files.is_empty()
    }
}

// --- sello ---------------------------------------------------------------------------------------------------------------------

/// Sin archivos de sello (modo `app` sin `stampFiles`) todos los nombres llevan el mismo sello fijo.
pub const SELLO_FIJO: &str = "000000";

/// 6 hex en mayúsculas del md5 de los archivos, en orden. `None` si falta alguno. Con un solo archivo es exactamente lo que
/// calcula el libro con `\pdf@filemdfivesum{estilo_figuras.tex}`.
pub fn sello(root: &Path, files: &[String]) -> Option<String> {
    if files.is_empty() {
        return Some(SELLO_FIJO.into());
    }
    let mut h = Md5::new();
    for f in files {
        h.update(fs::read(root.join(f)).ok()?);
    }
    Some(format!("{:X}", h.finalize())[..6].to_string())
}

// --- lo que hay en la carpeta ---------------------------------------------------------------------------------------------------

/// Una figura del cache: todos los archivos con el mismo nombre base (`.pdf`, `.md5`, `.dpth`, `.log`...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiguraEnCache {
    pub nombre: String,
    pub pdf: bool,
    pub md5: bool,
    pub log: bool,
    pub bytes: u64,
}

/// `A1B2C3-cauer-7` a `("A1B2C3", "cauer", 7)`. `None` si no es un nombre con sello.
pub fn partir_nombre(base: &str) -> Option<(String, String, u32)> {
    let (sello, resto) = base.split_once('-')?;
    if sello.len() != 6 || !sello.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()) {
        return None;
    }
    let (slug, n) = resto.rsplit_once('-')?;
    if slug.is_empty() {
        return None;
    }
    Some((sello.to_string(), slug.to_string(), n.parse().ok()?))
}

fn base_de(archivo: &str) -> &str {
    archivo.split('.').next().unwrap_or(archivo)
}

/// Lo que genera pgf para una figura. Sólo estos archivos hacen a una figura del cache: el resto de lo que haya en la carpeta (los
/// `.run.xml` que deja biblatex en cada subcompilación, por ejemplo) no es una figura ni cuenta en sus tamaños.
const EXTENSIONES_DE_FIGURA: [&str; 6] = ["pdf", "md5", "dpth", "log", "aux", "auxlock"];

/// Lo que dejan las subcompilaciones de pgf al lado de la figura y no sirve a nadie: la limpieza lo borra siempre.
fn es_residuo(archivo: &str) -> bool {
    archivo.to_ascii_lowercase().ends_with(".run.xml")
}

/// Las figuras de la carpeta del cache, ordenadas por nombre.
pub fn escanear(root: &Path, dir: &str) -> Vec<FiguraEnCache> {
    let mut m: BTreeMap<String, FiguraEnCache> = BTreeMap::new();
    let Ok(rd) = fs::read_dir(root.join(dir)) else { return vec![] };
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let archivo = e.file_name().to_string_lossy().to_string();
        if !EXTENSIONES_DE_FIGURA.contains(&archivo.rsplit('.').next().unwrap_or("")) {
            continue;
        }
        let base = base_de(&archivo).to_string();
        let f = m.entry(base.clone()).or_insert(FiguraEnCache { nombre: base, pdf: false, md5: false, log: false, bytes: 0 });
        f.bytes += meta.len();
        match archivo.rsplit('.').next() {
            Some("pdf") => f.pdf = true,
            Some("md5") => f.md5 = true,
            Some("log") => f.log = true,
            _ => {}
        }
    }
    m.into_values().collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoCache {
    /// El sello de hoy, si se pudo calcular.
    pub sello: Option<String>,
    /// Figuras con PDF y el sello de hoy.
    pub actuales: usize,
    /// Figuras con PDF de otros sellos (lo que la limpieza puede liberar).
    pub viejas: usize,
    /// Figuras con PDF y un nombre sin sello (no se pueden clasificar).
    pub sin_sello: usize,
    pub bytes: u64,
    pub bytes_viejos: u64,
    /// El sello con más figuras entre los que no son el de hoy, y cuántas tiene.
    pub sello_anterior: Option<(String, usize)>,
}

pub fn estado_del_cache(figuras: &[FiguraEnCache], sello_hoy: Option<&str>) -> EstadoCache {
    let mut e = EstadoCache { sello: sello_hoy.map(String::from), ..Default::default() };
    let mut por_sello: BTreeMap<String, usize> = BTreeMap::new();
    for f in figuras {
        e.bytes += f.bytes;
        let parte = partir_nombre(&f.nombre);
        let vieja = parte.as_ref().is_some_and(|(s, _, _)| Some(s.as_str()) != sello_hoy);
        if vieja {
            e.bytes_viejos += f.bytes;
        }
        if !f.pdf {
            continue;
        }
        match parte {
            Some((s, _, _)) if Some(s.as_str()) == sello_hoy => e.actuales += 1,
            Some((s, _, _)) => {
                e.viejas += 1;
                *por_sello.entry(s).or_default() += 1;
            }
            None => e.sin_sello += 1,
        }
    }
    e.sello_anterior = por_sello.into_iter().max_by_key(|(_, n)| *n);
    e
}

/// ¿Hay que cocinar antes de compilar? Sin ninguna figura del sello de hoy, o con menos del 60 % de las del sello que más
/// tiene entre los otros (lo que queda cuando se guardó encima de una cocción a medio hacer). Un md5 y un listado de carpeta.
/// Sólo para proyectos con sello en los nombres.
pub fn necesita_cocer(cfg: &FigureCfg, e: &EstadoCache) -> bool {
    if cfg.modo == Modo::Off || !cfg.usa_sello() || e.sello.is_none() {
        return false;
    }
    if e.actuales == 0 {
        return true;
    }
    e.sello_anterior.as_ref().is_some_and(|(_, previas)| (e.actuales as f64) < 0.6 * (*previas as f64))
}

// --- la lista del último listado ---------------------------------------------------------------------------------------------------

/// Lo que dejó el último listado (`.lv/figlist.json`): qué figuras pide el proyecto con este sello y cuáles había que cocinar.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Figlist {
    pub sello: String,
    /// Del documento entero (todas las partes). Sólo una lista completa autoriza a limpiar: la de un parcial nombra las
    /// figuras de sus partes y borraría las de todos los demás capítulos.
    pub completa: bool,
    pub fecha_ms: u64,
    /// Los nombres como los escribe pgf: `figuras-cache/A1B2C3-cauer-0`.
    pub nombres: Vec<String>,
    pub pendientes: Vec<String>,
    pub fallidas: Vec<String>,
    /// `huella_de_figuras` del proyecto cuando esta lista quedó cocida del todo (completa, sin pendientes ni fallidas). Si es la
    /// misma que la de ahora, no cambió nada que pueda cambiar una figura y el listado previo a un build se saltea.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub huella: Option<String>,
}

pub fn leer_figlist(root: &Path) -> Option<Figlist> {
    serde_json::from_slice(&fs::read(root.join(FIGLIST_FILE)).ok()?).ok()
}

pub fn guardar_figlist(root: &Path, f: &Figlist) -> Result<()> {
    let mut t = serde_json::to_string_pretty(f).map_err(|e| Error::Other(e.to_string()))?;
    t.push('\n');
    crate::build::write_if_changed(&root.join(FIGLIST_FILE), &t)?;
    Ok(())
}

/// Los nombres de la figlist que escribe pgf (`<jobname>.figlist`, uno por línea).
pub fn parsear_figlist(texto: &str) -> Vec<String> {
    let mut vistos = BTreeSet::new();
    texto
        .lines()
        .map(|l| l.trim().replace('\\', "/"))
        .filter(|l| !l.is_empty() && !l.contains("..") && !l.starts_with('/') && !l.contains(':'))
        .filter(|l| vistos.insert(l.clone()))
        .collect()
}

fn leer_md5(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok().map(|t| t.trim().to_string())
}

/// Las figuras que hay que cocinar: les falta el PDF, o el `.md5` que escribió el listado (`.lv/build/cocina/...`) difiere en
/// **contenido** del que está en el cache compartido (el de la figura tal como se cocinó). No por fecha: los `.md5` cambian de
/// carpeta y una copia no siempre conserva el mtime.
pub fn pendientes(root: &Path, nombres: &[String]) -> Vec<String> {
    let listado = build_dir(root, "cocina");
    nombres
        .iter()
        .filter(|n| {
            let pdf = root.join(format!("{n}.pdf"));
            if !pdf.is_file() {
                return true;
            }
            let compartido = leer_md5(&root.join(format!("{n}.md5")));
            match (leer_md5(&listado.join(format!("{n}.md5"))), compartido) {
                (Some(nuevo), Some(viejo)) => nuevo != viejo,
                (None, Some(_)) => false, // el listado no escribió su md5: no hay con qué comparar y la figura está
                (_, None) => true,        // un PDF sin `.md5` no se puede dar por bueno
            }
        })
        .cloned()
        .collect()
}

// --- huella de las figuras ---------------------------------------------------------------------------------------------------------------

/// Los trozos de `t` entre `ini` y su cierre `fin` (el cierre de `\begin{figure}` también acepta `figure*`). Un `\begin` sin cierre
/// toma hasta el final del archivo: de más es seguro (la huella cambia con cualquier edición de ahí en adelante), de menos no.
fn trozos<'a>(t: &'a str, ini: &str, fin: &str, fuera: &mut Vec<&'a str>) {
    let mut pos = 0;
    while let Some(i) = t[pos..].find(ini) {
        let desde = pos + i;
        let fin_de = match t[desde..].find(fin) {
            Some(j) => {
                let e = desde + j + fin.len();
                t[e..].find('}').map_or(t.len(), |k| e + k + 1)
            }
            None => t.len(),
        };
        fuera.push(&t[desde..fin_de]);
        pos = fin_de;
    }
}

/// Todo lo que, escrito en un archivo de una parte, puede cambiar una figura sin que el estilo (el sello) cambie: los entornos
/// `figure` y `tikzpicture` y las líneas que definen cosas (`\def`, `\newcommand`, `\tikzset`, `\setlength`, `\FigurasDe`...: una
/// macro que define un capítulo y usa la figura de otro). El texto corrido no entra.
fn lo_que_toca_una_figura(t: &str) -> Vec<&str> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| {
        Regex::new(
            r"(?m)^[ \t]*\\(?:[gex]?def|newcommand|renewcommand|providecommand|DeclareRobustCommand|tikzset|tikzstyle|pgfkeys|usetikzlibrary|usepackage|RequirePackage|newlength|setlength|newcounter|setcounter|pgfmath\w+|FigurasDe)\b[^\n]*",
        )
        .expect("patrón válido")
    });
    let mut v = Vec::new();
    trozos(t, "\\begin{figure", "\\end{figure", &mut v);
    trozos(t, "\\begin{tikzpicture}", "\\end{tikzpicture}", &mut v);
    v.extend(re.find_iter(t).map(|m| m.as_str()));
    v
}

/// md5 (hex) de lo que puede cambiar una figura: el sello, el conjunto de archivos que tienen algo que toca una figura y su
/// contenido (`lo_que_toca_una_figura`) en los archivos de una parte, y el archivo entero en los que no son de ninguna parte (el
/// preámbulo, la raíz, `structure.tex`: ahí se definen las macros que usan las figuras). Un cambio de texto en un capítulo no la
/// cambia; agregar, quitar o editar una figura, sí.
///
/// `datos`: los archivos que una figura lee desde adentro de su `tikzpicture` (`graph::DatoDeTikz`): `\input{datos}`, imágenes,
/// `plot file`. pgf no los ve (hashea la línea `\input{datos}`, no su contenido) y con la figura en el cache el documento ni los
/// abre, así que entran **enteros** en la huella, sean `.tex`, de una parte o binarios (su md5 es el de sus bytes).
///
/// Es lo que permite a un perfil que sólo consume el cache saltear el listado previo (8 s en el libro) cuando nada cambió. No
/// detecta lo que cambie por afuera de los archivos del grafo (un `.sty` propio): ahí vale el botón Cocinar, que lista siempre.
pub fn huella_de_figuras(root: &Path, archivos: &BTreeSet<String>, datos: &BTreeSet<String>, es_de_parte: &dyn Fn(&str) -> bool, sello: &str) -> String {
    let mut h = Md5::new();
    h.update(sello.as_bytes());
    for rel in datos.iter().filter(|r| !r.to_ascii_lowercase().ends_with(".tex")) {
        match fs::read(root.join(rel)) {
            Ok(bytes) => h.update(format!("\0dato\0{rel}\0{:X}\0", Md5::digest(&bytes)).as_bytes()),
            Err(_) => h.update(format!("\0falta\0{rel}").as_bytes()),
        }
    }
    for rel in archivos.iter().filter(|r| r.to_ascii_lowercase().ends_with(".tex")) {
        let Ok(bytes) = fs::read(root.join(rel)) else {
            h.update(format!("\0falta\0{rel}").as_bytes());
            continue;
        };
        if !es_de_parte(rel) || datos.contains(rel) {
            h.update(format!("\0entero\0{rel}\0").as_bytes());
            h.update(&bytes);
            continue;
        }
        let texto = String::from_utf8_lossy(&bytes);
        let piezas = lo_que_toca_una_figura(&texto);
        if piezas.is_empty() {
            continue;
        }
        h.update(format!("\0parte\0{rel}\0").as_bytes());
        for p in piezas {
            h.update(p.as_bytes());
            h.update(b"\0");
        }
    }
    format!("{:X}", h.finalize())
}

// --- archivos que una figura lee desde adentro de su tikzpicture ------------------------------------------------------------------------

pub const DATOS_FILE: &str = ".lv/tikz-datos.json";

/// Un archivo que lee una figura desde adentro de su `tikzpicture` y las figuras que dependen de él.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatoDeFigura {
    pub dato: String,
    /// Los slugs de las figuras del archivo que lo incluye; `None` si no se sabe de cuál es el dibujo (se invalidan todas).
    pub slugs: Option<Vec<String>>,
}

/// Lo que se sabe de un archivo de datos la última vez que se lo miró. Con el mismo tamaño y la misma fecha de modificación no se
/// vuelve a calcular el md5 (un build sin cambios no tiene que leer las imágenes y los datos de todas las figuras).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DatoGuardado {
    tamano: u64,
    mtime_ms: u64,
    md5: String,
}

/// El estado de `.lv/tikz-datos.json`. El formato anterior (sólo el md5, como texto) se lee con un tamaño imposible: el primer
/// build lo recalcula y lo reescribe en el formato nuevo, sin invalidar nada si el md5 no cambió.
fn leer_datos_guardados(root: &Path) -> BTreeMap<String, DatoGuardado> {
    let Some(serde_json::Value::Object(m)) = fs::read(root.join(DATOS_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()) else { return BTreeMap::new() };
    m.into_iter()
        .filter_map(|(k, v)| match v {
            serde_json::Value::String(md5) => Some((k, DatoGuardado { tamano: u64::MAX, mtime_ms: 0, md5 })),
            v => serde_json::from_value(v).ok().map(|d| (k, d)),
        })
        .collect()
}

/// Tamaño y fecha del archivo, y su md5 sólo si cambiaron respecto de `previo`.
fn mirar_dato(p: &Path, previo: Option<&DatoGuardado>) -> DatoGuardado {
    let Ok(meta) = fs::metadata(p) else { return DatoGuardado { tamano: 0, mtime_ms: 0, md5: "falta".into() } };
    let tamano = meta.len();
    let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    if let Some(d) = previo.filter(|d| d.tamano == tamano && d.mtime_ms == mtime_ms && d.md5 != "falta") {
        return d.clone();
    }
    let md5 = fs::read(p).map_or_else(|_| "falta".into(), |b| format!("{:X}", Md5::digest(&b)));
    DatoGuardado { tamano, mtime_ms, md5 }
}

/// pgf decide si una figura cambió con el md5 del texto de su dibujo **tal como está escrito**: con un `\input{datos}` adentro,
/// hashea esa línea y no `datos.tex`; y latexmk tampoco lo ve, porque con la figura en el cache el documento no abre el archivo
/// (reproducido: se cambia `datos.tex`, 0 subcompilaciones y la imagen idéntica). Por eso la app guarda en `.lv/tikz-datos.json` el md5
/// de cada uno de esos archivos y, si alguno cambió (o es la primera vez que lo ve), borra los `.md5` de las figuras de quien lo
/// incluye, de **todos** los sellos (deshacer un estilo no tiene que devolver una figura vieja) y en el cache y en el directorio de cada
/// perfil. Sin `.md5` pgf recocina la figura (y la verificación de figuras la revisa), y la lista de la cocción la da por pendiente.
/// También borra el `.fdb_latexmk` de cada perfil: sin él latexmk, que no ve el cambio, diría «nada que hacer».
///
/// Devuelve los nombres de las figuras invalidadas. Se llama antes de cada build de un perfil que externaliza y antes de cada cocción.
pub fn invalidar_por_datos(root: &Path, dir: &str, datos: &[DatoDeFigura]) -> Vec<String> {
    let guardado = leer_datos_guardados(root);
    let mut nuevo = BTreeMap::new();
    let mut cambiados: Vec<&DatoDeFigura> = Vec::new();
    for d in datos {
        let previo = guardado.get(&d.dato);
        let ahora = mirar_dato(&root.join(&d.dato), previo);
        if previo.map(|p| &p.md5) != Some(&ahora.md5) {
            cambiados.push(d);
        }
        nuevo.insert(d.dato.clone(), ahora);
    }
    let mut borradas: BTreeSet<String> = BTreeSet::new();
    if !cambiados.is_empty() {
        let figuras = escanear(root, dir);
        for d in cambiados {
            for f in &figuras {
                let Some((_, slug, _)) = partir_nombre(&f.nombre) else { continue };
                if d.slugs.as_ref().is_none_or(|v| v.contains(&slug)) {
                    borradas.insert(f.nombre.clone());
                }
            }
        }
        let perfiles: Vec<std::path::PathBuf> = fs::read_dir(root.join(".lv/build")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        for n in &borradas {
            let _ = fs::remove_file(root.join(dir).join(format!("{n}.md5")));
            for p in &perfiles {
                let _ = fs::remove_file(p.join(dir).join(format!("{n}.md5")));
            }
        }
        if !borradas.is_empty() {
            for p in &perfiles {
                if let Some(nombre) = p.file_name().and_then(|n| n.to_str()) {
                    let _ = fs::remove_file(p.join(format!("lv-{nombre}.fdb_latexmk")));
                }
            }
        }
    }
    if nuevo != guardado {
        if let Ok(mut t) = serde_json::to_string_pretty(&nuevo) {
            t.push('\n');
            let _ = crate::build::write_if_changed(&root.join(DATOS_FILE), &t);
        }
    }
    borradas.into_iter().collect()
}

// --- slug y archivo -------------------------------------------------------------------------------------------------------------------

/// Qué archivo declara cada slug con `\FigurasDe{slug}` (la convención del libro), para mostrar las figuras por archivo.
pub fn slugs_por_archivo(root: &Path, archivos: &BTreeSet<String>) -> BTreeMap<String, String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"\\FigurasDe\s*\{([A-Za-z0-9_.-]+)\}").expect("patrón válido"));
    let mut m = BTreeMap::new();
    for rel in archivos {
        let Ok(t) = fs::read_to_string(root.join(rel)) else { continue };
        for l in t.lines() {
            if let Some(c) = re.captures(crate::graph::sin_comentario(l)) {
                m.entry(c[1].to_string()).or_insert_with(|| rel.clone());
            }
        }
    }
    m
}

/// Los slugs con los que el modo `app` nombra las figuras de cada archivo: el nombre del archivo sin extensión, en minúsculas y
/// con `-` en lugar de lo que no sea letra ni número. Dos archivos con el mismo nombre en carpetas distintas llevan además 4
/// hex del md5 de su ruta (se pisarían las figuras en silencio). Se genera una vez por proyecto: un archivo nuevo que no choca
/// con otro no cambia el slug de ninguno.
pub fn slugs_app(archivos: &BTreeSet<String>) -> BTreeMap<String, String> {
    let base = |rel: &str| -> String {
        let stem = rel.rsplit('/').next().unwrap_or(rel);
        let stem = stem.rsplit_once('.').map_or(stem, |(a, _)| a);
        let mut s = String::new();
        for c in stem.chars() {
            let c = if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' };
            if c != '-' || !s.ends_with('-') {
                s.push(c);
            }
        }
        let s = s.trim_matches('-').to_string();
        if s.is_empty() {
            "f".into()
        } else {
            s
        }
    };
    let mut cuenta: BTreeMap<String, usize> = BTreeMap::new();
    for a in archivos {
        *cuenta.entry(base(a)).or_default() += 1;
    }
    archivos
        .iter()
        .map(|a| {
            let b = base(a);
            let slug = if cuenta[&b] > 1 { format!("{b}-{}", &format!("{:x}", Md5::digest(a.as_bytes()))[..4]) } else { b };
            (a.clone(), slug)
        })
        .collect()
}

// --- limpieza -------------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limpieza {
    /// Rutas relativas a la raíz.
    pub archivos: Vec<String>,
    pub bytes: u64,
    /// Cuántas figuras distintas (nombres base) se llevan esos archivos.
    pub figuras: usize,
}

// La limpieza sólo toca los archivos de una figura (`EXTENSIONES_DE_FIGURA`) y los residuos de pgf (`es_residuo`): aunque la
// configuración apuntara a una carpeta con otras cosas, no se borra nada que no tenga pinta de figura.

fn dir_de_cache_seguro(dir: &str) -> bool {
    let d = dir.trim_matches('/');
    !d.is_empty() && d != "." && !d.starts_with(".lv") && !d.starts_with('.') && ruta_relativa_valida(d)
}

/// Lo que se borraría: todo lo de la carpeta del cache cuyo nombre base no está en la figlist. Sólo con una lista completa del
/// sello de hoy; si no, error (nunca se limpia contra la lista de un parcial ni contra la de otro sello).
pub fn limpieza_preview(root: &Path, dir: &str, sello_hoy: &str, f: Option<&Figlist>) -> Result<Limpieza> {
    let Some(f) = f else { return Err(Error::Other("todavía no se listaron las figuras del proyecto: cociná primero".into())) };
    if !f.completa {
        return Err(Error::Other("la última lista es de un perfil parcial: lo que no nombra puede ser de otro capítulo. Cociná todo antes de limpiar".into()));
    }
    if f.sello != sello_hoy {
        return Err(Error::Other("la lista de figuras es de otro sello: cociná antes de limpiar".into()));
    }
    if !dir_de_cache_seguro(dir) {
        return Err(Error::Other(format!("no se limpia la carpeta {dir:?}: no parece un cache de figuras")));
    }
    let vivos: BTreeSet<&str> = f.nombres.iter().map(|n| n.rsplit('/').next().unwrap_or(n)).collect();
    let mut l = Limpieza::default();
    let mut bases = BTreeSet::new();
    let Ok(rd) = fs::read_dir(root.join(dir)) else { return Ok(l) };
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let archivo = e.file_name().to_string_lossy().to_string();
        let ext = archivo.rsplit('.').next().unwrap_or("");
        let residuo = es_residuo(&archivo);
        let viva = vivos.contains(base_de(&archivo));
        if !meta.is_file() || !(residuo || (EXTENSIONES_DE_FIGURA.contains(&ext) && !viva)) {
            continue;
        }
        l.bytes += meta.len();
        if !viva && !residuo {
            bases.insert(base_de(&archivo).to_string());
        }
        l.archivos.push(format!("{}/{archivo}", dir.trim_matches('/')));
    }
    l.archivos.sort();
    l.figuras = bases.len();
    Ok(l)
}

/// Borra lo que `limpieza_preview` dijo. Devuelve lo que borró.
pub fn limpiar(root: &Path, dir: &str, sello_hoy: &str, f: Option<&Figlist>) -> Result<Limpieza> {
    let l = limpieza_preview(root, dir, sello_hoy, f)?;
    let mut hecho = Limpieza { figuras: l.figuras, ..Default::default() };
    for rel in &l.archivos {
        let p = root.join(rel);
        let bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if fs::remove_file(&p).is_ok() {
            hecho.bytes += bytes;
            hecho.archivos.push(rel.clone());
        }
    }
    Ok(hecho)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::infer_config;

    fn escribir(root: &Path, rel: &str, t: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, t).unwrap();
    }

    fn cfg_con(json: &str) -> FigureCfg {
        let mut c = infer_config("main.tex", false);
        c.figure_cache = Some(serde_json::from_str(json).unwrap());
        FigureCfg::de(&c)
    }

    #[test]
    fn la_configuracion_se_lee_con_sus_valores_por_defecto() {
        let c = cfg_con(r#"{ "mode": "app", "dir": "img/cache", "stampFiles": ["estilo.tex", "../fuera.tex", "a\\b.tex"], "onlyInFigureEnv": false, "parallelJobs": 6 }"#);
        assert_eq!((c.modo, c.dir.as_str(), c.only_in_figure_env, c.jobs), (Modo::App, "img/cache", false, 6));
        assert_eq!(c.stamp_files, ["estilo.tex", "a/b.tex"], "una ruta que sale de la raíz se descarta y las barras se normalizan");
        let d = cfg_con("{}");
        assert_eq!((d.modo, d.dir.as_str(), d.only_in_figure_env), (Modo::Off, "figuras-cache", true), "sin perfiles que externalicen no hay nada que hacer");
        assert!(d.jobs >= 1 && !d.usa_sello());
        assert_eq!(cfg_con(r#"{ "parallelJobs": "auto" }"#).jobs, nucleos());
        assert_eq!(cfg_con(r#"{ "parallelJobs": 500 }"#).jobs, 64);
        let mut c = infer_config("main.tex", false);
        c.profiles.get_mut("completo").unwrap().externalize = true;
        assert_eq!(FigureCfg::de(&c).modo, Modo::Project, "un perfil que externaliza y nada dicho: el proyecto trae sus macros");
    }

    #[test]
    fn el_sello_de_un_archivo_es_el_md5_en_mayusculas_y_cambia_con_el_contenido() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), "estilo.tex", "abc");
        // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
        assert_eq!(sello(d.path(), &["estilo.tex".into()]).as_deref(), Some("900150"));
        escribir(d.path(), "estilo.tex", "abcd");
        assert_ne!(sello(d.path(), &["estilo.tex".into()]).as_deref(), Some("900150"));
        assert_eq!(sello(d.path(), &["no-esta.tex".into()]), None);
        assert_eq!(sello(d.path(), &[]).as_deref(), Some(SELLO_FIJO));
        escribir(d.path(), "otro.tex", "x");
        let dos = sello(d.path(), &["estilo.tex".into(), "otro.tex".into()]).unwrap();
        assert_ne!(Some(dos), sello(d.path(), &["otro.tex".into(), "estilo.tex".into()]), "el orden cuenta");
    }

    #[test]
    fn la_huella_ignora_el_texto_de_un_capitulo_y_sigue_a_sus_figuras_y_al_preambulo() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let archivos: BTreeSet<String> = ["main.tex", "cap.tex", "texto.tex", "fig_x.tex", "imagen.png"].iter().map(|s| s.to_string()).collect();
        let de_parte = |rel: &str| rel != "main.tex";
        let datos: BTreeSet<String> = BTreeSet::new();
        let huella = |sello: &str| huella_de_figuras(r, &archivos, &datos, &de_parte, sello);
        escribir(r, "main.tex", "\\def\\wp{1}\n\\input{cap}\n");
        escribir(r, "cap.tex", "\\FigurasDe{cap}\nTexto uno.\n\\begin{figure}[H]\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n\\end{figure}\nTexto dos.\n");
        escribir(r, "texto.tex", "Sólo texto.\n");
        escribir(r, "fig_x.tex", "\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}\n");
        let base = huella("AAAAAA");
        assert_eq!(base, huella("AAAAAA"), "estable");
        assert_ne!(base, huella("BBBBBB"), "el sello cuenta");

        // Texto corrido de un capítulo, en cualquier lugar (también entre figuras): no cambia nada.
        escribir(r, "cap.tex", "\\FigurasDe{cap}\nTexto UNO, más largo.\n\\begin{figure}[H]\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n\\end{figure}\nOtro texto.\n");
        escribir(r, "texto.tex", "Otro texto que no toca figuras.\n");
        assert_eq!(base, huella("AAAAAA"), "un cambio de texto no invalida la huella");
        // Un archivo de una parte sin nada que toque una figura no cuenta aunque se escriba o se borre.
        // Una figura editada, en un archivo de capítulo y en uno de figura suelto: cambia.
        escribir(r, "cap.tex", "\\FigurasDe{cap}\nTexto uno.\n\\begin{figure}[H]\n\\begin{tikzpicture}\\draw (0,0)--(2,2);\\end{tikzpicture}\n\\end{figure}\nTexto dos.\n");
        let editada = huella("AAAAAA");
        assert_ne!(base, editada);
        escribir(r, "cap.tex", "\\FigurasDe{cap}\nTexto uno.\n\\begin{figure}[H]\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n\\end{figure}\nTexto dos.\n");
        assert_eq!(base, huella("AAAAAA"), "deshacerlo devuelve la misma huella");
        escribir(r, "fig_x.tex", "\\begin{tikzpicture}\\draw (0,0) circle (2);\\end{tikzpicture}\n");
        assert_ne!(base, huella("AAAAAA"), "una figura de un archivo `\\input`");
        escribir(r, "fig_x.tex", "\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}\n");
        // Una macro de un capítulo y otra del preámbulo (archivo que no es de ninguna parte, entero).
        escribir(r, "texto.tex", "\\newcommand{\\wp}{3}\nTexto.\n");
        assert_ne!(base, huella("AAAAAA"), "una definición en un capítulo");
        escribir(r, "texto.tex", "Sólo texto.\n");
        escribir(r, "main.tex", "\\def\\wp{1}\n\\input{cap}\nuna línea más\n");
        assert_ne!(base, huella("AAAAAA"), "el preámbulo entra entero");
        // Una figura nueva en un archivo que no tenía.
        escribir(r, "main.tex", "\\def\\wp{1}\n\\input{cap}\n");
        escribir(r, "texto.tex", "\\begin{figure}\\begin{tikzpicture}\\end{tikzpicture}\\end{figure}\n");
        assert_ne!(base, huella("AAAAAA"), "figura nueva en un archivo sin figuras");
        // Un `\begin{figure}` sin cierre toma hasta el final: lo que sigue ya cuenta.
        escribir(r, "texto.tex", "\\begin{figure}\nabierta\n");
        let abierta = huella("AAAAAA");
        escribir(r, "texto.tex", "\\begin{figure}\nabierta y más\n");
        assert_ne!(abierta, huella("AAAAAA"));
        // El conjunto de archivos del grafo también es parte de la huella: un archivo menos, otra huella.
        let sin: BTreeSet<String> = archivos.iter().filter(|a| *a != "fig_x.tex").cloned().collect();
        escribir(r, "texto.tex", "Sólo texto.\n");
        assert_ne!(base, huella_de_figuras(r, &sin, &datos, &de_parte, "AAAAAA"));
    }

    #[test]
    fn un_archivo_que_una_figura_lee_entra_entero_en_la_huella_sea_texto_de_una_parte_o_binario() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let archivos: BTreeSet<String> = ["main.tex", "cap.tex", "datos.tex"].iter().map(|s| s.to_string()).collect();
        let de_parte = |rel: &str| rel != "main.tex";
        escribir(r, "main.tex", "\\input{cap}\n");
        escribir(r, "cap.tex", "\\FigurasDe{cap}\n\\begin{figure}\\begin{tikzpicture}\\input{datos}\\end{tikzpicture}\\end{figure}\n");
        escribir(r, "datos.tex", "\\draw (0,0)--(1,1);\n");
        fs::write(r.join("imagen.png"), [1u8, 2, 3]).unwrap();
        let sin_datos = BTreeSet::new();
        let con: BTreeSet<String> = ["datos.tex", "imagen.png"].iter().map(|s| s.to_string()).collect();
        let h = |datos: &BTreeSet<String>| huella_de_figuras(r, &archivos, datos, &de_parte, "AAAAAA");
        let base = h(&con);
        assert_ne!(base, h(&sin_datos), "el conjunto de datos cuenta");
        // `datos.tex` es de la parte `cap` y no tiene ningún `tikzpicture`: sin ser dato no contaría; como dato, entra entero.
        escribir(r, "datos.tex", "\\draw (0,0)--(2,2);\n");
        assert_ne!(base, h(&con), "el contenido de un `.tex` leído desde un tikzpicture");
        assert_eq!(h(&sin_datos), { escribir(r, "datos.tex", "otra cosa\n"); h(&sin_datos) }, "sin ser dato, un archivo sin figuras no cuenta");
        escribir(r, "datos.tex", "\\draw (0,0)--(1,1);\n");
        assert_eq!(base, h(&con));
        // Un binario entra por su md5.
        fs::write(r.join("imagen.png"), [1u8, 2, 4]).unwrap();
        assert_ne!(base, h(&con), "los bytes de una imagen");
        fs::remove_file(r.join("imagen.png")).unwrap();
        assert_ne!(base, h(&con), "un archivo leído que ya no está");
    }

    fn dato(dato: &str, slugs: Option<&[&str]>) -> DatoDeFigura {
        DatoDeFigura { dato: dato.into(), slugs: slugs.map(|s| s.iter().map(|x| x.to_string()).collect()) }
    }

    #[test]
    fn si_un_archivo_leido_cambia_se_invalidan_las_figuras_de_su_slug_en_todos_los_sellos_y_perfiles() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for n in ["AAAAAA-cap-0", "AAAAAA-cap-1", "AAAAAA-otro-0", "BBBBBB-cap-0"] {
            for e in ["pdf", "md5"] {
                escribir(r, &format!("figuras-cache/{n}.{e}"), "x");
            }
            escribir(r, &format!(".lv/build/rapido/figuras-cache/{n}.md5"), "x");
        }
        escribir(r, ".lv/build/rapido/lv-rapido.fdb_latexmk", "fdb");
        escribir(r, ".lv/build/parcial/lv-parcial.fdb_latexmk", "fdb");
        escribir(r, "datos.tex", "uno");
        let datos = [dato("datos.tex", Some(&["cap"]))];
        // La primera vez no hay md5 guardado: se invalida (no se sabe si el cache es de este contenido).
        let b = invalidar_por_datos(r, "figuras-cache", &datos);
        assert_eq!(b, ["AAAAAA-cap-0", "AAAAAA-cap-1", "BBBBBB-cap-0"], "las del slug `cap` de todos los sellos; `otro` no");
        for n in &b {
            assert!(!r.join(format!("figuras-cache/{n}.md5")).exists() && !r.join(format!(".lv/build/rapido/figuras-cache/{n}.md5")).exists(), "{n}");
            assert!(r.join(format!("figuras-cache/{n}.pdf")).is_file(), "el PDF queda: lo reemplaza la recocción");
        }
        assert!(r.join("figuras-cache/AAAAAA-otro-0.md5").is_file());
        assert!(!r.join(".lv/build/rapido/lv-rapido.fdb_latexmk").exists() && !r.join(".lv/build/parcial/lv-parcial.fdb_latexmk").exists(), "latexmk no ve el cambio: sin su fdb corre");
        // Sin cambios: nada. Con un cambio: otra vez.
        escribir(r, "figuras-cache/AAAAAA-cap-0.md5", "nuevo");
        escribir(r, ".lv/build/rapido/lv-rapido.fdb_latexmk", "fdb");
        assert!(invalidar_por_datos(r, "figuras-cache", &datos).is_empty());
        assert!(r.join("figuras-cache/AAAAAA-cap-0.md5").is_file() && r.join(".lv/build/rapido/lv-rapido.fdb_latexmk").is_file());
        escribir(r, "datos.tex", "dos dos");
        assert_eq!(invalidar_por_datos(r, "figuras-cache", &datos), ["AAAAAA-cap-0", "AAAAAA-cap-1", "BBBBBB-cap-0"]);
        // Sin slug conocido se invalidan todas; un dato que deja de leerse se olvida y uno nuevo cuenta como cambiado.
        escribir(r, "datos.tex", "tres tres tres");
        let todas = invalidar_por_datos(r, "figuras-cache", &[dato("datos.tex", None)]);
        assert_eq!(todas.len(), 4);
        assert!(invalidar_por_datos(r, "figuras-cache", &[]).is_empty());
        assert_eq!(invalidar_por_datos(r, "figuras-cache", &[dato("datos.tex", Some(&["otro"]))]), ["AAAAAA-otro-0"]);
    }

    #[test]
    fn los_nombres_con_sello_se_parten_y_los_demas_no() {
        assert_eq!(partir_nombre("6D06AB-cauer-12"), Some(("6D06AB".into(), "cauer".into(), 12)));
        assert_eq!(partir_nombre("6D06AB-anexo-cauer-3"), Some(("6D06AB".into(), "anexo-cauer".into(), 3)));
        assert_eq!(partir_nombre("lv-figs-figure0"), None);
        assert_eq!(partir_nombre("6d06ab-cauer-1"), None, "el sello va en mayúsculas");
        assert_eq!(partir_nombre("6D06AB-cauer"), None);
        assert_eq!(partir_nombre("6D06AB--1"), None);
    }

    fn cache(d: &Path) {
        // 3 figuras de hoy, 4 de A1B2C3, 1 de FFFFFF, una sin sello, y una de hoy sin PDF (falló).
        for n in ["6D06AB-a-0", "6D06AB-a-1", "6D06AB-b-0"] {
            for e in ["pdf", "md5", "dpth", "log"] {
                escribir(d, &format!("figuras-cache/{n}.{e}"), "xx");
            }
        }
        for n in ["A1B2C3-a-0", "A1B2C3-a-1", "A1B2C3-b-0", "A1B2C3-c-0", "FFFFFF-a-0"] {
            for e in ["pdf", "md5"] {
                escribir(d, &format!("figuras-cache/{n}.{e}"), "yyyy");
            }
        }
        escribir(d, "figuras-cache/lv-figs-figure0.pdf", "z");
        escribir(d, "figuras-cache/6D06AB-roto-0.log", "log");
    }

    #[test]
    fn el_estado_cuenta_actuales_viejas_y_el_sello_anterior_mas_poblado() {
        let d = tempfile::tempdir().unwrap();
        cache(d.path());
        let figs = escanear(d.path(), "figuras-cache");
        let e = estado_del_cache(&figs, Some("6D06AB"));
        assert_eq!((e.actuales, e.viejas, e.sin_sello), (3, 5, 1));
        assert_eq!(e.sello_anterior, Some(("A1B2C3".to_string(), 4)));
        assert!(e.bytes_viejos > 0 && e.bytes > e.bytes_viejos);
        let sin_sello_hoy = estado_del_cache(&figs, None);
        assert_eq!(sin_sello_hoy.actuales, 0);
    }

    #[test]
    fn el_disparo_automatico_sigue_la_regla_del_60_por_ciento_y_pide_sello() {
        let c = cfg_con(r#"{ "mode": "project", "stampFiles": ["estilo.tex"] }"#);
        assert!(necesita_cocer(&c, &EstadoCache { sello: Some("X".into()), actuales: 0, ..Default::default() }), "ninguna figura del sello de hoy");
        let e = |act: usize, prev: usize| EstadoCache { sello: Some("X".into()), actuales: act, sello_anterior: Some(("A".into(), prev)), ..Default::default() };
        assert!(necesita_cocer(&c, &e(94, 158)), "94 es el 59,5 %");
        assert!(!necesita_cocer(&c, &e(95, 158)), "95 es el 60,1 %");
        assert!(!necesita_cocer(&c, &EstadoCache { sello: Some("X".into()), actuales: 5, sello_anterior: None, ..Default::default() }), "nada con qué comparar");
        // Sin sello en los nombres, apagado o sin sello calculado: nunca.
        let sin = cfg_con(r#"{ "mode": "project" }"#);
        assert!(!necesita_cocer(&sin, &EstadoCache { sello: Some("X".into()), actuales: 0, ..Default::default() }));
        let off = cfg_con(r#"{ "mode": "off", "stampFiles": ["estilo.tex"] }"#);
        assert!(!necesita_cocer(&off, &EstadoCache { sello: Some("X".into()), actuales: 0, ..Default::default() }));
        assert!(!necesita_cocer(&c, &EstadoCache { sello: None, ..Default::default() }));
    }

    #[test]
    fn la_figlist_de_pgf_se_lee_sin_vacias_ni_repetidas_ni_rutas_peligrosas() {
        let t = "figuras-cache/A-a-0\n\n  figuras-cache\\A-a-1  \nfiguras-cache/A-a-0\n../fuera\nC:/x\n/abs\n";
        assert_eq!(parsear_figlist(t), ["figuras-cache/A-a-0", "figuras-cache/A-a-1"]);
    }

    #[test]
    fn pendiente_es_pdf_que_falta_o_md5_distinto_en_contenido_no_en_fecha() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let n = |x: &str| format!("figuras-cache/{x}");
        // ok: PDF y md5 iguales.
        escribir(r, "figuras-cache/ok.pdf", "p");
        escribir(r, "figuras-cache/ok.md5", "igual\n");
        escribir(r, ".lv/build/cocina/figuras-cache/ok.md5", "igual");
        // cambio: el md5 del listado es otro.
        escribir(r, "figuras-cache/cambio.pdf", "p");
        escribir(r, "figuras-cache/cambio.md5", "viejo");
        escribir(r, ".lv/build/cocina/figuras-cache/cambio.md5", "nuevo");
        // falta: sin PDF.
        escribir(r, ".lv/build/cocina/figuras-cache/falta.md5", "x");
        // sin-md5: PDF sin md5 compartido.
        escribir(r, "figuras-cache/sin-md5.pdf", "p");
        escribir(r, ".lv/build/cocina/figuras-cache/sin-md5.md5", "x");
        // sin-listado: PDF y md5 compartido pero el listado no escribió el suyo.
        escribir(r, "figuras-cache/sin-listado.pdf", "p");
        escribir(r, "figuras-cache/sin-listado.md5", "x");
        let todos: Vec<String> = ["ok", "cambio", "falta", "sin-md5", "sin-listado"].iter().map(|x| n(x)).collect();
        assert_eq!(pendientes(r, &todos), [n("cambio"), n("falta"), n("sin-md5")]);
    }

    #[test]
    fn los_slugs_se_asignan_al_archivo_que_los_declara_ignorando_comentarios() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), "Secciones/Uno.tex", "\\FigurasDe{uno}\nTexto\n% \\FigurasDe{comentado}\n");
        escribir(d.path(), "Secciones/Dos.tex", "x \\FigurasDe{anexo-dos} y\n");
        let archivos: BTreeSet<String> = ["Secciones/Uno.tex", "Secciones/Dos.tex", "Secciones/NoEsta.tex"].iter().map(|s| s.to_string()).collect();
        let m = slugs_por_archivo(d.path(), &archivos);
        assert_eq!(m.get("uno").map(String::as_str), Some("Secciones/Uno.tex"));
        assert_eq!(m.get("anexo-dos").map(String::as_str), Some("Secciones/Dos.tex"));
        assert!(!m.contains_key("comentado"));
    }

    fn figlist(completa: bool, sello: &str) -> Figlist {
        Figlist { sello: sello.into(), completa, nombres: ["figuras-cache/6D06AB-a-0", "figuras-cache/6D06AB-a-1", "figuras-cache/6D06AB-b-0"].iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn la_limpieza_borra_lo_que_la_lista_no_nombra_y_deja_lo_demas() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        cache(r);
        escribir(r, "figuras-cache/LEEME.txt", "no es una figura");
        let f = figlist(true, "6D06AB");
        let p = limpieza_preview(r, "figuras-cache", "6D06AB", Some(&f)).unwrap();
        // Sobreviven las 3 de la lista; se van las 5 de otros sellos, la sin sello, y el log de la que falló... (no está en la lista).
        assert_eq!(p.figuras, 5 + 1 + 1);
        assert!(p.archivos.contains(&"figuras-cache/A1B2C3-a-0.pdf".to_string()) && p.archivos.contains(&"figuras-cache/lv-figs-figure0.pdf".to_string()));
        assert!(!p.archivos.iter().any(|a| a.contains("6D06AB-a-0") || a.ends_with("LEEME.txt")), "{:?}", p.archivos);
        let hecho = limpiar(r, "figuras-cache", "6D06AB", Some(&f)).unwrap();
        assert_eq!(hecho.archivos, p.archivos);
        assert_eq!(hecho.bytes, p.bytes);
        for n in ["6D06AB-a-0", "6D06AB-a-1", "6D06AB-b-0"] {
            assert!(r.join(format!("figuras-cache/{n}.pdf")).is_file(), "{n} sobrevive");
        }
        assert!(r.join("figuras-cache/LEEME.txt").is_file());
        assert!(!r.join("figuras-cache/A1B2C3-a-0.pdf").exists());
    }

    #[test]
    fn el_md5_de_un_dato_se_calcula_solo_si_cambio_su_tamano_o_su_fecha_y_el_formato_viejo_se_migra() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, "figuras-cache/AAAAAA-cap-0.pdf", "pdf");
        escribir(r, "figuras-cache/AAAAAA-cap-0.md5", "md5");
        escribir(r, "datos.tex", "contenido");
        let datos = [dato("datos.tex", Some(&["cap"]))];
        invalidar_por_datos(r, "figuras-cache", &datos);
        let guardado = leer_datos_guardados(r);
        let g = &guardado["datos.tex"];
        assert_eq!(g.tamano, "contenido".len() as u64);
        assert_eq!(g.md5, format!("{:X}", Md5::digest(b"contenido")));
        // Con el mismo tamaño y la misma fecha no se lee el archivo: un md5 guardado de mentira sigue valiendo (prueba de que no se recalculó).
        let mut m = guardado.clone();
        m.get_mut("datos.tex").unwrap().md5 = "NO-SE-RECALCULA".into();
        fs::write(r.join(DATOS_FILE), serde_json::to_string(&m).unwrap()).unwrap();
        escribir(r, "figuras-cache/AAAAAA-cap-0.md5", "md5");
        assert!(invalidar_por_datos(r, "figuras-cache", &datos).is_empty(), "mismo tamaño y fecha: no se mira el contenido");
        assert!(r.join("figuras-cache/AAAAAA-cap-0.md5").is_file());
        // Si cambia el tamaño sí se calcula (y se ve que el md5 ya no es el guardado).
        escribir(r, "datos.tex", "contenido más largo");
        assert_eq!(invalidar_por_datos(r, "figuras-cache", &datos), ["AAAAAA-cap-0"]);
        assert_eq!(leer_datos_guardados(r)["datos.tex"].md5, format!("{:X}", Md5::digest("contenido más largo".as_bytes())));
        // El formato anterior (sólo el md5 como texto): con el md5 igual no invalida nada y se reescribe en el formato nuevo.
        let md5 = format!("{:X}", Md5::digest("contenido más largo".as_bytes()));
        fs::write(r.join(DATOS_FILE), format!("{{ \"datos.tex\": \"{md5}\" }}")).unwrap();
        escribir(r, "figuras-cache/AAAAAA-cap-0.md5", "md5");
        assert!(invalidar_por_datos(r, "figuras-cache", &datos).is_empty());
        assert!(r.join("figuras-cache/AAAAAA-cap-0.md5").is_file());
        assert_eq!(leer_datos_guardados(r)["datos.tex"].md5, md5);
        assert!(fs::read_to_string(r.join(DATOS_FILE)).unwrap().contains("tamano"));
    }

    #[test]
    fn el_run_xml_de_biblatex_no_es_una_figura_ni_impide_el_disparo_y_la_limpieza_lo_borra() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        // Cuatro figuras del sello anterior y, del sello nuevo, sólo lo que dejó una subcompilación: el `.run.xml` de biblatex.
        for n in ["AAAAAA-a-0", "AAAAAA-a-1", "AAAAAA-b-0", "AAAAAA-b-1"] {
            escribir(r, &format!("figuras-cache/{n}.pdf"), "pdf");
            escribir(r, &format!("figuras-cache/{n}.md5"), "md5");
        }
        escribir(r, "figuras-cache/BBBBBB-a-0.run.xml", "<xml/>");
        let figs = escanear(r, "figuras-cache");
        assert_eq!(figs.len(), 4, "el run.xml no es una figura: {figs:?}");
        let e = estado_del_cache(&figs, Some("BBBBBB"));
        assert_eq!((e.actuales, e.viejas), (0, 4));
        assert_eq!(e.bytes, figs.iter().map(|f| f.bytes).sum::<u64>(), "ni cuenta en los tamaños");
        let c = cfg_con(r#"{ "mode": "project", "stampFiles": ["estilo.tex"] }"#);
        assert!(necesita_cocer(&c, &e), "con el run.xml del sello nuevo como única huella, hay que cocinar igual");
        // La limpieza contra una lista completa del sello nuevo se lleva el run.xml (de una figura viva o no) y no cuenta como figura.
        escribir(r, "figuras-cache/BBBBBB-a-0.pdf", "pdf");
        escribir(r, "figuras-cache/BBBBBB-a-0.md5", "md5");
        escribir(r, "figuras-cache/CCCCCC-z-0.run.xml", "<xml/>");
        let f = Figlist { sello: "BBBBBB".into(), completa: true, nombres: vec!["figuras-cache/BBBBBB-a-0".into()], ..Default::default() };
        let p = limpieza_preview(r, "figuras-cache", "BBBBBB", Some(&f)).unwrap();
        assert!(p.archivos.contains(&"figuras-cache/BBBBBB-a-0.run.xml".to_string()) && p.archivos.contains(&"figuras-cache/CCCCCC-z-0.run.xml".to_string()), "{:?}", p.archivos);
        assert_eq!(p.figuras, 4, "las 4 del sello anterior; un run.xml solo no es una figura");
        limpiar(r, "figuras-cache", "BBBBBB", Some(&f)).unwrap();
        let quedan: Vec<String> = fs::read_dir(r.join("figuras-cache")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(quedan.len(), 2, "{quedan:?}");
    }

    #[test]
    fn la_limpieza_se_niega_sin_lista_completa_del_sello_de_hoy() {
        let d = tempfile::tempdir().unwrap();
        cache(d.path());
        let r = d.path();
        assert!(limpieza_preview(r, "figuras-cache", "6D06AB", None).is_err());
        let e = limpieza_preview(r, "figuras-cache", "6D06AB", Some(&figlist(false, "6D06AB"))).unwrap_err().to_string();
        assert!(e.contains("parcial"), "{e}");
        let e = limpieza_preview(r, "figuras-cache", "6D06AB", Some(&figlist(true, "OTRO00"))).unwrap_err().to_string();
        assert!(e.contains("otro sello"), "{e}");
        assert!(r.join("figuras-cache/A1B2C3-a-0.pdf").is_file(), "no se borró nada");
    }

    #[test]
    fn la_limpieza_no_toca_una_carpeta_que_no_parece_un_cache() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), "main.tex", "x");
        escribir(d.path(), "dato.pdf", "x");
        let f = figlist(true, "6D06AB");
        for malo in [".", "", "/", ".lv/build", ".git", "..", "a/../b"] {
            assert!(limpieza_preview(d.path(), malo, "6D06AB", Some(&f)).is_err(), "{malo:?}");
        }
        assert!(d.path().join("dato.pdf").is_file() && d.path().join("main.tex").is_file());
    }

    #[test]
    fn solo_se_borran_extensiones_de_figura() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, "img/cache/X-viejo.pdf", "x");
        escribir(r, "img/cache/X-viejo.tex", "fuente de una figura hecha a mano");
        escribir(r, "img/cache/notas.docx", "x");
        let f = figlist(true, "6D06AB");
        let h = limpiar(r, "img/cache", "6D06AB", Some(&f)).unwrap();
        assert_eq!(h.archivos, ["img/cache/X-viejo.pdf"]);
        assert!(r.join("img/cache/X-viejo.tex").is_file() && r.join("img/cache/notas.docx").is_file());
    }

    #[test]
    fn los_slugs_del_modo_app_salen_del_nombre_y_se_desambiguan_si_chocan() {
        let a: BTreeSet<String> = ["main.tex", "Secciones/Cap Uno.tex", "a/intro.tex", "b/intro.tex", "ñ.tex"].iter().map(|s| s.to_string()).collect();
        let m = slugs_app(&a);
        assert_eq!(m["main.tex"], "main");
        assert_eq!(m["Secciones/Cap Uno.tex"], "cap-uno");
        assert_eq!(m["ñ.tex"], "f");
        assert!(m["a/intro.tex"].starts_with("intro-") && m["b/intro.tex"].starts_with("intro-") && m["a/intro.tex"] != m["b/intro.tex"], "{m:?}");
        // Un archivo nuevo que no choca no cambia el slug de los demás.
        let mut b = a.clone();
        b.insert("cap-nuevo.tex".into());
        let n = slugs_app(&b);
        assert_eq!(n["main.tex"], "main");
        assert_eq!(n["a/intro.tex"], m["a/intro.tex"]);
        for slug in m.values() {
            assert!(partir_nombre(&format!("6D06AB-{slug}-0")).is_some(), "{slug} tiene que ser un nombre que el cache entienda");
        }
    }

    #[test]
    fn la_figlist_guardada_se_lee_igual() {
        let d = tempfile::tempdir().unwrap();
        let mut f = figlist(true, "6D06AB");
        f.pendientes = vec!["figuras-cache/6D06AB-a-1".into()];
        f.fecha_ms = 12345;
        guardar_figlist(d.path(), &f).unwrap();
        assert_eq!(leer_figlist(d.path()), Some(f));
        assert_eq!(leer_figlist(&d.path().join("no-existe")), None);
    }
}
