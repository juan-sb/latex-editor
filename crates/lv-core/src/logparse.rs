//! Parser del log de TeX (y de biber y makeindex): del texto crudo a una lista de problemas con archivo y línea (5.8 del
//! plan).
//!
//! Qué se sabe del formato, todo visto en logs reales (`fixtures/logs/`):
//! - Con `-file-line-error` los errores salen como `archivo:línea: mensaje`; sin él, como `! mensaje` seguido de `l.<n>`.
//!   Los dos formatos conviven en el mismo log (un `! LaTeX Error: File ... not found` sale con `!` aunque lo demás no).
//! - Los archivos que TeX abre se marcan con `(ruta` y se cierran con `)`; la ruta puede llevar espacios y tildes sin
//!   comillas (`(Secciones/Aproximación de Butterworth.tex`). Los `(` y `)` del texto de un mensaje no cuentan: **sólo se
//!   cuentan los de las líneas de traza**, y un bloque de mensaje (error, aviso, overfull) termina en la primera línea en
//!   blanco. Un `(` sólo abre un archivo si lo que sigue parece una ruta; si no (`(HO)`, `(biblatex)`) se lo salta entero.
//! - Un párrafo que termina justo al empezar otro archivo imprime su `Overfull` con la pila ya cambiada (`(a.tex) (b.tex`
//!   y después `Overfull ... at lines 2--1`, con el final antes que el principio): se lo atribuye al archivo que se cerró
//!   recién, no al nuevo.
//! - El log trae bytes sueltos que no son UTF-8 (las palabras cortadas con guion en codificación T1): se decodifica con
//!   reemplazo y el parser no se detiene.
//! - Con `-max-print-line=10000` ninguna línea se corta a las 79 columnas, así que los mensajes y las rutas llegan enteros.

use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    /// `Overfull` / `Underfull`: cajas mal llenas. Son tantas que la interfaz las muestra aparte.
    Badbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub severity: Severity,
    /// `tex`, `undefined-reference`, `undefined-citation`, `package`, `overfull`, `underfull`, `missing-char`, `biber`,
    /// `makeindex`, `file-not-found`.
    pub kind: String,
    pub message: String,
    /// Relativo a la raíz y con `/`. `None` si el archivo es del sistema, del driver o no se pudo atribuir.
    pub file: Option<String>,
    pub line: Option<u32>,
    /// Última línea del rango (`Overfull ... at lines 5--7`), si lo hay.
    pub line_end: Option<u32>,
    /// Lo que TeX muestra del lugar del error (`l.12 ...`), en una línea.
    pub context: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub errors: u32,
    pub warnings: u32,
    pub badboxes: u32,
}

pub fn count(p: &[Problem]) -> Counts {
    let mut c = Counts::default();
    for x in p {
        match x.severity {
            Severity::Error => c.errors += 1,
            Severity::Warning => c.warnings += 1,
            Severity::Badbox => c.badboxes += 1,
        }
    }
    c
}

fn re(cell: &'static OnceLock<Regex>, patron: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(patron).expect("patrón válido"))
}

// --- rutas ---------------------------------------------------------------------------------------------------------------

/// Una ruta del log, relativa a la raíz y con `/`; `None` si es del driver, del sistema o no existe en el proyecto.
fn atribuir(root: &Path, raw: &str) -> Option<String> {
    let mut s = raw.trim().trim_matches('"').replace('\\', "/");
    while let Some(r) = s.strip_prefix("./") {
        s = r.to_string();
    }
    let raiz = root.display().to_string().replace('\\', "/");
    let raiz = raiz.trim_start_matches("//?/");
    // Sin distinguir mayúsculas: Windows escribe `C:` o `c:` según quién lo pida.
    let prefijo = format!("{raiz}/");
    let sin_raiz = (s.len() > prefijo.len() && s.is_char_boundary(prefijo.len()) && s[..prefijo.len()].eq_ignore_ascii_case(&prefijo))
        .then(|| s[prefijo.len()..].to_string());
    let rel = match sin_raiz {
        Some(r) => r,
        None if s.contains(':') || s.starts_with('/') => return None, // absoluta fuera del proyecto
        None => s,
    };
    if rel.is_empty() || rel.starts_with(".lv/") || rel.split('/').any(|c| c == "..") {
        return None;
    }
    root.join(&rel).is_file().then_some(rel)
}

/// ¿Lo que sigue a un `(` parece una ruta de archivo? Tiene que tener extensión de letras (`.tex`, `.sty`, `.run.xml`) o una barra.
fn parece_ruta(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let t = t.trim().trim_matches('"');
    !t.is_empty() && (re(&R, r"\.[A-Za-z][A-Za-z0-9]{0,4}$").is_match(t) || t.contains('/') || t.contains('\\'))
}

// --- el parser ----------------------------------------------------------------------------------------------------------

struct Entrada {
    archivo: Option<String>,
    /// Número de línea del log donde se abrió.
    abierto_en: usize,
}

struct Pila {
    pila: Vec<Entrada>,
    /// El último archivo que se cerró y la línea del log donde se cerró.
    cerrado: Option<(Option<String>, usize)>,
}

impl Pila {
    fn tope(&self) -> Option<String> {
        self.pila.last().and_then(|e| e.archivo.clone())
    }

    /// Procesa los `(` y `)` de una línea de traza.
    fn linea(&mut self, root: &Path, texto: &str, n: usize) {
        let cs: Vec<char> = texto.chars().collect();
        let mut i = 0;
        while i < cs.len() {
            match cs[i] {
                '(' => {
                    // El nombre llega hasta un `)`, otro `(`, un número de página (` [12`) o una marca de imagen (` <`).
                    let mut j = i + 1;
                    while j < cs.len() {
                        let c = cs[j];
                        if c == ')' || c == '(' || (c == ' ' && matches!(cs.get(j + 1), Some('[') | Some('<'))) {
                            break;
                        }
                        j += 1;
                    }
                    let nombre: String = cs[i + 1..j].iter().collect();
                    if parece_ruta(&nombre) {
                        self.pila.push(Entrada { archivo: atribuir(root, &nombre), abierto_en: n });
                        i = j;
                    } else {
                        // `(HO)`, `(biblatex)`: se lo salta entero, con su `)`.
                        i = if cs.get(j) == Some(&')') { j + 1 } else { j };
                    }
                }
                ')' => {
                    if let Some(e) = self.pila.pop() {
                        self.cerrado = Some((e.archivo, n));
                    }
                    i += 1;
                }
                _ => i += 1,
            }
        }
    }
}

/// Mensajes del propio TeX o de un paquete: un bloque que sigue hasta la línea en blanco. Sus paréntesis no son de archivos.
fn empieza_bloque(l: &str) -> bool {
    l.starts_with('!')
        || l.starts_with("LaTeX Warning:")
        || l.starts_with("LaTeX Font Warning:")
        || l.starts_with("Overfull ")
        || l.starts_with("Underfull ")
        || l.starts_with("Missing character:")
        || l.starts_with("Runaway ")
        || ((l.starts_with("Package ") || l.starts_with("Class ")) && (l.contains(" Warning:") || l.contains(" Error:")))
}

/// Los `Info` no terminan en una línea en blanco: la sigue directamente lo que venga (otro mensaje, un `)` que cierra un
/// archivo). Son la línea más sus continuaciones `(paquete)   texto`.
fn es_info(l: &str) -> bool {
    l.starts_with("LaTeX Info:") || ((l.starts_with("Package ") || l.starts_with("Class ")) && l.contains(" Info:"))
}

fn es_continuacion_de_paquete(l: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\([A-Za-z][\w.-]*\)\s").is_match(l)
}

/// `archivo.tex:12: mensaje` de `-file-line-error`.
fn error_con_archivo(l: &str) -> Option<(&str, u32, &str)> {
    static R: OnceLock<Regex> = OnceLock::new();
    let c = re(&R, r"^(.+?\.[A-Za-z][A-Za-z0-9]{0,4}):(\d+): (.*)$").captures(l)?;
    let (f, n, m) = (c.get(1)?.as_str(), c.get(2)?.as_str().parse().ok()?, c.get(3)?.as_str());
    (!f.starts_with(' ')).then_some((f, n, m))
}

fn linea_de_contexto(l: &str) -> Option<u32> {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^l\.(\d+)").captures(l)?.get(1)?.as_str().parse().ok()
}

fn en_input_line(texto: &str) -> Option<u32> {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"on input line (\d+)").captures(texto)?.get(1)?.as_str().parse().ok()
}

fn clasificar_error(msg: &str) -> &'static str {
    if msg.contains("not found") && msg.contains("File") {
        "file-not-found"
    } else {
        "tex"
    }
}

/// Un aviso de LaTeX o de un paquete ya reunido en una sola línea.
fn clasificar_aviso(texto: &str) -> &'static str {
    if texto.contains("Reference `") && texto.contains("undefined") {
        "undefined-reference"
    } else if texto.contains("Citation `") && texto.contains("undefined") || texto.contains("Citation '") && texto.contains("undefined") {
        "undefined-citation"
    } else if texto.starts_with("Package ") || texto.starts_with("Class ") {
        "package"
    } else {
        "tex"
    }
}

/// Avisos que son un resumen o una invitación a volver a compilar, no un problema del documento.
fn es_ruido(texto: &str) -> bool {
    texto.contains("There were undefined references")
        || texto.contains("There were multiply-defined labels")
        || texto.contains("Label(s) may have changed")
        || texto.contains("Please (re)run Biber")
        || texto.contains("Please rerun LaTeX")
        || texto.starts_with("==> Fatal error")
}

pub fn parse_tex_log(bytes: &[u8], root: &Path) -> Vec<Problem> {
    let texto = String::from_utf8_lossy(bytes);
    let lineas: Vec<&str> = texto.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let mut pila = Pila { pila: Vec::new(), cerrado: None };
    let mut out: Vec<Problem> = Vec::new();
    let mut i = 0;
    while i < lineas.len() {
        let l = lineas[i];
        // Dónde termina el bloque de mensaje que empieza acá (primera línea en blanco).
        let fin_bloque = |desde: usize| lineas[desde..].iter().position(|x| x.trim().is_empty()).map_or(lineas.len(), |p| desde + p);

        if let Some((f, n, msg)) = error_con_archivo(l) {
            let fin = fin_bloque(i).min(i + 40);
            let (linea, contexto) = contexto_de(&lineas[i + 1..fin]);
            let msg = msg.trim();
            if !es_ruido(msg) {
                out.push(Problem {
                    severity: Severity::Error,
                    kind: clasificar_error(msg).into(),
                    message: msg.to_string(),
                    file: atribuir(root, f),
                    line: Some(linea.unwrap_or(n)),
                    line_end: None,
                    context: contexto,
                });
            }
            i = fin;
            continue;
        }
        if let Some(msg) = l.strip_prefix("! ") {
            let fin = fin_bloque(i).min(i + 40);
            let (linea, contexto) = contexto_de(&lineas[i + 1..fin]);
            let msg = msg.trim();
            if !es_ruido(msg) {
                out.push(Problem {
                    severity: Severity::Error,
                    kind: clasificar_error(msg).into(),
                    message: msg.to_string(),
                    file: pila.tope(),
                    line: linea,
                    line_end: None,
                    context: contexto,
                });
            }
            i = fin;
            continue;
        }
        if l.starts_with("LaTeX Warning:") || l.starts_with("LaTeX Font Warning:") || (l.starts_with("Package ") || l.starts_with("Class ")) && l.contains(" Warning:") {
            let fin = fin_bloque(i);
            // Las continuaciones de un paquete empiezan con `(paquete)`: se las saca y se junta todo en una línea.
            let mut partes = vec![l.trim().to_string()];
            for c in &lineas[i + 1..fin] {
                let c = c.trim();
                let c = if c.starts_with('(') { c.split_once(')').map_or(c, |x| x.1.trim()) } else { c };
                if !c.is_empty() {
                    partes.push(c.to_string());
                }
            }
            let junto = partes.join(" ");
            if !es_ruido(&junto) {
                let linea = en_input_line(&junto);
                out.push(Problem {
                    severity: Severity::Warning,
                    kind: clasificar_aviso(&junto).into(),
                    message: junto
                        .trim_start_matches("LaTeX Warning: ")
                        .trim_start_matches("LaTeX Font Warning: ")
                        .to_string(),
                    file: if linea.is_some() { pila.tope() } else { None },
                    line: linea,
                    line_end: None,
                    context: String::new(),
                });
            }
            i = fin;
            continue;
        }
        if l.starts_with("Overfull \\") || l.starts_with("Underfull \\") {
            out.push(badbox(l, &pila, i));
            i = fin_bloque(i);
            continue;
        }
        if l.starts_with("Missing character:") {
            out.push(Problem {
                severity: Severity::Warning,
                kind: "missing-char".into(),
                message: l.trim().to_string(),
                file: pila.tope(),
                line: None,
                line_end: None,
                context: String::new(),
            });
            i = fin_bloque(i);
            continue;
        }
        if empieza_bloque(l) {
            i = fin_bloque(i);
            continue;
        }
        if es_info(l) {
            i += 1;
            while i < lineas.len() && es_continuacion_de_paquete(lineas[i]) {
                i += 1;
            }
            continue;
        }
        pila.linea(root, l, i);
        i += 1;
    }
    // `! LaTeX Error: File `x' not found.` no trae `l.N` (TeX pregunta el nombre y recién después, ya en nonstopmode,
    // aborta con `Emergency stop` y su `l.N`): la línea del aborto es la del archivo que falta.
    for k in 0..out.len().saturating_sub(1) {
        if out[k].kind == "file-not-found" && out[k].line.is_none() && out[k + 1].message.starts_with("Emergency stop") {
            out[k].line = out[k + 1].line;
            if out[k].file.is_none() {
                out[k].file = out[k + 1].file.clone();
            }
        }
    }
    deduplicar(out)
}

/// Del cuerpo de un error: la línea de `l.<n>` y lo que TeX muestra (esa línea y la siguiente, juntas).
fn contexto_de(cuerpo: &[&str]) -> (Option<u32>, String) {
    for (k, c) in cuerpo.iter().enumerate() {
        if let Some(n) = linea_de_contexto(c) {
            let sigue = cuerpo.get(k + 1).map_or("", |s| s.trim());
            let c = c.trim_start_matches(|ch: char| ch != ' ').trim();
            return (Some(n), format!("{c} {sigue}").trim().to_string());
        }
    }
    (None, String::new())
}

fn badbox(l: &str, pila: &Pila, n: usize) -> Problem {
    static R: OnceLock<Regex> = OnceLock::new();
    static D: OnceLock<Regex> = OnceLock::new();
    let kind = if l.starts_with("Overfull") { "overfull" } else { "underfull" };
    let (mut linea, mut fin, mut file) = (None, None, pila.tope());
    if let Some(c) = re(&R, r"at lines (\d+)--(\d+)").captures(l) {
        let a: u32 = c[1].parse().unwrap_or(0);
        let b: u32 = c[2].parse().unwrap_or(0);
        linea = Some(a);
        fin = Some(b.max(a));
        // `a > b`: el párrafo terminó al empezar otro archivo, y la pila ya cambió (ver el comentario del módulo).
        if a > b {
            if let (Some((cerrado, en)), Some(top)) = (&pila.cerrado, pila.pila.last()) {
                if top.abierto_en + 1 >= n && *en + 1 >= top.abierto_en {
                    file = cerrado.clone();
                }
            }
        }
    } else if let Some(c) = re(&D, r"detected at line (\d+)").captures(l) {
        linea = c[1].parse().ok();
    }
    // Sin línea (`\vbox ... while \output is active`) no hay dónde marcar: un archivo sería una pista falsa.
    let file = if linea.is_some() { file } else { None };
    Problem { severity: Severity::Badbox, kind: kind.into(), message: l.trim().to_string(), file, line: linea, line_end: fin, context: String::new() }
}

/// Un mismo problema en el mismo lugar se cuenta una vez (un error que TeX repite al reintentar). Los que no tienen línea
/// no se pueden distinguir por lugar, y cada uno es una ocurrencia distinta: se conservan todos, así los conteos coinciden
/// con lo que cuenta un `grep` del log (el libro tiene decenas de `Underfull box ... while \output is active`).
fn deduplicar(v: Vec<Problem>) -> Vec<Problem> {
    let mut vistos = std::collections::HashSet::new();
    v.into_iter().filter(|p| p.line.is_none() || vistos.insert((p.severity as u8, p.message.clone(), p.file.clone(), p.line))).collect()
}

// --- biber y makeindex -----------------------------------------------------------------------------------------------

/// `ERROR -` y `WARN -` del `.blg` de biber. El archivo sale de la última línea `Found BibTeX data source '...'`.
pub fn parse_biber_log(bytes: &[u8], root: &Path) -> Vec<Problem> {
    static E: OnceLock<Regex> = OnceLock::new();
    static F: OnceLock<Regex> = OnceLock::new();
    static N: OnceLock<Regex> = OnceLock::new();
    let texto = String::from_utf8_lossy(bytes);
    let mut fuente: Option<String> = None;
    let mut out = Vec::new();
    for l in texto.lines() {
        if let Some(c) = re(&F, r"Found BibTeX data source '([^']+)'").captures(l) {
            fuente = atribuir(root, &c[1]);
            continue;
        }
        let Some(c) = re(&E, r"^\[\d+\] \S+> (ERROR|WARN) - (.*)$").captures(l) else { continue };
        let msg = c[2].trim().to_string();
        let linea = re(&N, r"line (\d+)").captures(&msg).and_then(|x| x[1].parse().ok());
        out.push(Problem {
            severity: if &c[1] == "ERROR" { Severity::Error } else { Severity::Warning },
            kind: "biber".into(),
            // El mensaje de biber lleva la ruta de un temporal (`...\biber_tmp_xxx\hash.utf8`): sin ese ruido.
            message: limpiar_temporal_de_biber(&msg),
            file: if linea.is_some() { fuente.clone() } else { None },
            line: linea,
            line_end: None,
            context: String::new(),
        });
    }
    deduplicar(out)
}

fn limpiar_temporal_de_biber(m: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"[A-Za-z]:[^ ,]*biber_tmp_[^ ,]*\.utf8").replace_all(m, "la base de datos").into_owned()
}

/// `!! Input index error` y `## Warning` del `.ilg` de makeindex (el mensaje está en la línea que sigue).
pub fn parse_makeindex_log(bytes: &[u8], root: &Path) -> Vec<Problem> {
    static R: OnceLock<Regex> = OnceLock::new();
    let texto = String::from_utf8_lossy(bytes);
    let ls: Vec<&str> = texto.lines().collect();
    let mut out = Vec::new();
    for (k, l) in ls.iter().enumerate() {
        let (sev, cab) = if let Some(c) = l.strip_prefix("!! ") {
            (Severity::Error, c)
        } else if let Some(c) = l.strip_prefix("## Warning") {
            (Severity::Warning, c)
        } else {
            continue;
        };
        let sigue = ls.get(k + 1).map_or("", |s| s.trim_start_matches("-- ").trim());
        let c = re(&R, r"(?:file|input) = ([^,;)]+), line = (\d+)").captures(cab);
        out.push(Problem {
            severity: sev,
            kind: "makeindex".into(),
            message: format!("{} {}", cab.trim().trim_end_matches(':').trim(), sigue).trim().to_string(),
            file: c.as_ref().and_then(|c| atribuir(root, &c[1])),
            line: c.as_ref().and_then(|c| c[2].parse().ok()),
            line_end: None,
            context: String::new(),
        });
    }
    deduplicar(out)
}

/// Todos los problemas del último build de un perfil: su `.log`, el `.blg` de biber y el `.ilg` de makeindex (los que existan).
pub fn problems_of_profile(root: &Path, perfil: &str) -> Vec<Problem> {
    let dir = crate::auxiliares::build_dir(root, perfil);
    let leer = |ext: &str| std::fs::read(dir.join(format!("lv-{perfil}.{ext}"))).ok();
    let mut out = leer("log").map(|b| parse_tex_log(&b, root)).unwrap_or_default();
    out.extend(leer("blg").map(|b| parse_biber_log(&b, root)).unwrap_or_default());
    out.extend(leer("ilg").map(|b| parse_makeindex_log(&b, root)).unwrap_or_default());
    out
}
