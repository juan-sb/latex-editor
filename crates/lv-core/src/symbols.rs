//! Índice de símbolos del proyecto (4.3 del plan) y lint liviano (10.2): etiquetas, usos, citas, entradas de `.bib`, secciones,
//! definiciones y archivos. Alimenta el autocompletado, ir a la definición, dónde se usa, el esquema y las marcas de lint.
//!
//! Igual que el grafo, no es un parser de TeX: busca los comandos que interesan con sus argumentos, ignora los comentarios y
//! descarta lo que es un parámetro de macro (`\label{#1}`). Las definiciones (`\newcommand`, `\newenvironment`...) se saltan
//! enteras, cuerpo incluido: adentro hay `\begin` sin `\end` y `\ref{#1}` que no son del documento.

use crate::graph::{sin_comentario, EdgeKind, ProjectIndex};
use crate::logparse::{Problem, Severity};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    pub file: String,
    pub line: u32,
    /// La línea donde está, sin el `\label{...}`; si quedó vacía, la anterior que tenga texto.
    pub context: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Use {
    pub name: String,
    /// El comando (`ref`, `eqref`, `cite`, `parencite`...).
    pub command: String,
    pub file: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BibEntry {
    pub key: String,
    /// `book`, `article`, `misc`...
    pub kind: String,
    pub file: String,
    pub line: u32,
    pub author: String,
    pub title: String,
    pub year: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Section {
    /// 0 `\part`, 1 `\chapter`, 2 `\section`, 3 `\subsection`, 4 `\subsubsection`, 5 `\paragraph`, 6 `\subparagraph`.
    pub level: u8,
    pub title: String,
    pub file: String,
    pub line: u32,
    /// La etiqueta que sigue al título (en las 4 líneas de abajo, antes de la sección siguiente).
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Def {
    /// Sin la barra: `Capitulo`, `RR`; en un entorno, su nombre.
    pub name: String,
    /// `command`, `operator`, `environment`, `theorem`, `tcolorbox`, `def`.
    pub kind: String,
    pub file: String,
    pub line: u32,
    /// Cantidad de argumentos (`[n]` de `\newcommand`), 0 si no dice.
    pub args: u8,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub rel: String,
    /// `tex`, `bib` o `image`.
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Symbols {
    pub labels: Vec<Label>,
    pub refs: Vec<Use>,
    pub cites: Vec<Use>,
    pub bib: Vec<BibEntry>,
    pub sections: Vec<Section>,
    pub defs: Vec<Def>,
    pub files: Vec<FileEntry>,
    /// Lo que el lint encontró sin compilar.
    pub lint: Vec<Problem>,
    pub scan_ms: u64,
}

// --- el escáner -----------------------------------------------------------------------------------------------------------

struct Firma {
    /// Argumentos obligatorios a leer (llaves, o una secuencia de control suelta si `suelto`).
    args: usize,
    suelto: bool,
    /// Después de los argumentos: leer `[n][default]` (definiciones).
    opciones_despues: bool,
    /// Cuántos grupos `{...}` de cuerpo se saltan enteros después.
    cuerpos: usize,
}

const REFS: [&str; 10] = ["ref", "eqref", "cref", "Cref", "pageref", "autoref", "nameref", "vref", "labelcref", "cpageref"];
const CITAS: [&str; 13] = [
    "cite", "citep", "citet", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite", "nocite", "fullcite", "smartcite", "supercite",
];
const SECCIONES: [&str; 7] = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

fn firma(n: &str) -> Option<Firma> {
    let uno = |cuerpos| Some(Firma { args: 1, suelto: false, opciones_despues: false, cuerpos });
    match n {
        "label" | "begin" | "end" | "bibitem" => uno(0),
        "newtheorem" => uno(0),
        "newtcolorbox" => Some(Firma { args: 1, suelto: false, opciones_despues: true, cuerpos: 1 }),
        "newenvironment" | "renewenvironment" => Some(Firma { args: 1, suelto: false, opciones_despues: true, cuerpos: 2 }),
        "newcommand" | "renewcommand" | "providecommand" => Some(Firma { args: 1, suelto: true, opciones_despues: true, cuerpos: 1 }),
        "DeclareMathOperator" => Some(Firma { args: 1, suelto: true, opciones_despues: false, cuerpos: 1 }),
        "NewDocumentCommand" | "RenewDocumentCommand" | "DeclareDocumentCommand" | "ProvideDocumentCommand" => {
            Some(Firma { args: 1, suelto: true, opciones_despues: false, cuerpos: 2 })
        }
        "def" => Some(Firma { args: 1, suelto: true, opciones_despues: false, cuerpos: 1 }),
        _ if REFS.contains(&n) || CITAS.contains(&n) || SECCIONES.contains(&n) => uno(0),
        _ => None,
    }
}

struct Cmd {
    nombre: String,
    estrella: bool,
    args: Vec<String>,
    /// `[...]` leídos antes o después de los argumentos.
    opciones: Vec<String>,
    linea: u32,
}

fn blancos(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// Grupo `{...}` balanceado que empieza en `i`: (contenido, posición siguiente).
fn llaves(b: &[u8], texto: &str, i: usize) -> Option<(String, usize)> {
    if b.get(i) != Some(&b'{') {
        return None;
    }
    let mut prof = 0;
    let mut j = i;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 1,
            b'{' => prof += 1,
            b'}' => {
                prof -= 1;
                if prof == 0 {
                    return Some((texto[i + 1..j].to_string(), j + 1));
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

/// Grupos `[...]` consecutivos a partir de `i`.
fn corchetes(b: &[u8], texto: &str, mut i: usize, out: &mut Vec<String>) -> usize {
    loop {
        let k = blancos(b, i);
        if b.get(k) != Some(&b'[') {
            return i;
        }
        let mut prof = 0;
        let mut j = k;
        let mut cierre = None;
        while j < b.len() && j - k < 400 {
            match b[j] {
                b'{' => prof += 1,
                b'}' => prof -= 1,
                b']' if prof <= 0 => {
                    cierre = Some(j);
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        let Some(c) = cierre else { return i };
        out.push(texto[k + 1..c].to_string());
        i = c + 1;
    }
}

fn escanear(texto: &str) -> Vec<Cmd> {
    let limpio: String = texto.lines().map(sin_comentario).collect::<Vec<_>>().join("\n");
    let b = limpio.as_bytes();
    let mut out = Vec::new();
    let (mut i, mut linea) = (0usize, 1u32);
    while i < b.len() {
        match b[i] {
            b'\n' => {
                linea += 1;
                i += 1;
            }
            b'\\' => {
                if i + 1 >= b.len() || !b[i + 1].is_ascii_alphabetic() {
                    i += 2;
                    continue;
                }
                let ini = i + 1;
                let mut j = ini;
                while j < b.len() && b[j].is_ascii_alphabetic() {
                    j += 1;
                }
                let nombre = &limpio[ini..j];
                i = j;
                let Some(f) = firma(nombre) else { continue };
                let linea_cmd = linea;
                let mut k = j;
                let estrella = b.get(blancos(b, k)) == Some(&b'*');
                if estrella {
                    k = blancos(b, k) + 1;
                }
                let mut opciones = Vec::new();
                k = corchetes(b, &limpio, k, &mut opciones);
                let mut args = Vec::new();
                for n in 0..f.args {
                    k = blancos(b, k);
                    if let Some((a, sig)) = llaves(b, &limpio, k) {
                        args.push(a);
                        k = sig;
                    } else if f.suelto && n == 0 && b.get(k) == Some(&b'\\') {
                        // `\newcommand\foo`: la secuencia de control suelta.
                        let mut m = k + 1;
                        while m < b.len() && b[m].is_ascii_alphabetic() {
                            m += 1;
                        }
                        args.push(limpio[k..m].to_string());
                        k = m;
                    } else {
                        break;
                    }
                }
                if args.len() < f.args {
                    continue;
                }
                if f.opciones_despues {
                    k = corchetes(b, &limpio, k, &mut opciones);
                }
                if nombre == "def" {
                    // `\def\foo#1#2{...}`: los parámetros hasta la llave del cuerpo.
                    while k < b.len() && b[k] != b'{' && b[k] != b'\n' {
                        k += 1;
                    }
                }
                let mut fin = k;
                for _ in 0..f.cuerpos {
                    let m = corchetes(b, &limpio, blancos(b, fin), &mut Vec::new());
                    match llaves(b, &limpio, blancos(b, m)) {
                        Some((_, sig)) => fin = sig,
                        None => break,
                    }
                }
                // Lo que se salteó (el cuerpo de una definición) cuenta para los números de línea.
                linea += limpio[j..fin.max(j)].bytes().filter(|&c| c == b'\n').count() as u32;
                out.push(Cmd { nombre: nombre.to_string(), estrella, args, opciones, linea: linea_cmd });
                i = fin.max(j);
            }
            _ => i += 1,
        }
    }
    out
}

fn titulo_legible(t: &str) -> String {
    let mut out = String::new();
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // Un comando se va; `\\` y los símbolos escapados quedan como espacio o como el símbolo.
                let mut nombre = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        nombre.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if nombre.is_empty() {
                    if let Some(s) = chars.next() {
                        out.push(if "%$&#_{}".contains(s) { s } else { ' ' });
                    }
                } else if nombre != "label" {
                    out.push(' ');
                }
            }
            '{' | '}' => {}
            '~' => out.push(' '),
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn recortar(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>().trim_end())
    }
}

// --- .bib ---------------------------------------------------------------------------------------------------------------------

/// Valor de un campo de BibTeX que empieza en `i`: `{...}` balanceado, `"..."` o un número/macro.
fn valor_bib(b: &[u8], t: &str, i: usize) -> (String, usize) {
    match b.get(i) {
        Some(b'{') => llaves(b, t, i).map_or((String::new(), b.len()), |(v, s)| (v, s)),
        Some(b'"') => {
            let mut j = i + 1;
            let mut prof = 0;
            while j < b.len() {
                match b[j] {
                    b'{' => prof += 1,
                    b'}' => prof -= 1,
                    b'"' if prof <= 0 => break,
                    _ => {}
                }
                j += 1;
            }
            (t[i + 1..j.min(b.len())].to_string(), (j + 1).min(b.len()))
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b')' | b'\n') {
                j += 1;
            }
            (t[i..j].trim().to_string(), j)
        }
    }
}

pub fn parse_bib(texto: &str, file: &str) -> Vec<BibEntry> {
    let b = texto.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut linea = 1u32;
    let mut hasta = 0usize; // los saltos de línea se cuentan de a trozos
    while i < b.len() {
        if b[i] != b'@' {
            i += 1;
            continue;
        }
        linea += texto[hasta..i].bytes().filter(|&c| c == b'\n').count() as u32;
        hasta = i;
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        let tipo = texto[i + 1..j].to_lowercase();
        let k = blancos(b, j);
        if !matches!(b.get(k), Some(b'{') | Some(b'(')) || matches!(tipo.as_str(), "comment" | "string" | "preamble") {
            i = j.max(i + 1);
            continue;
        }
        // La clave llega hasta la coma.
        let mut m = k + 1;
        while m < b.len() && b[m] != b',' && b[m] != b'}' {
            m += 1;
        }
        let clave = texto[k + 1..m].trim().to_string();
        let (mut autor, mut titulo, mut anio) = (String::new(), String::new(), String::new());
        let mut p = m;
        let cierre_ent = if b[k] == b'{' { b'}' } else { b')' };
        while p < b.len() && b[p] != cierre_ent {
            p = blancos(b, p + usize::from(b[p] == b','));
            if p >= b.len() || b[p] == cierre_ent {
                break;
            }
            let ini_campo = p;
            while p < b.len() && b[p] != b'=' && b[p] != b',' && b[p] != cierre_ent {
                p += 1;
            }
            if p >= b.len() || b[p] != b'=' {
                if p == ini_campo {
                    p += 1;
                }
                continue;
            }
            let campo = texto[ini_campo..p].trim().to_lowercase();
            let (valor, sig) = valor_bib(b, texto, blancos(b, p + 1));
            p = sig;
            let v = titulo_legible(&valor.replace('\n', " "));
            match campo.as_str() {
                "author" => autor = v,
                "title" => titulo = v,
                "year" | "date" => anio = v.chars().take(4).collect(),
                _ => {}
            }
            // Un valor concatenado con `#` se salta hasta la coma.
            while p < b.len() && b[p] != b',' && b[p] != cierre_ent {
                p += 1;
            }
        }
        if !clave.is_empty() {
            out.push(BibEntry { key: clave, kind: tipo, file: file.to_string(), line: linea, author: autor, title: titulo, year: anio });
        }
        i = p.max(i + 1);
    }
    out
}

// --- el índice -------------------------------------------------------------------------------------------------------------

/// Las secciones en el orden en que se leen: las de un archivo que entra por `\input` quedan en el lugar del `\input`, no al
/// final de las del archivo que lo trae.
fn ordenar_secciones(ix: &ProjectIndex, todas: Vec<Section>) -> Vec<Section> {
    fn expandir(ix: &ProjectIndex, rel: &str, por_archivo: &mut HashMap<String, Vec<Section>>, vistos: &mut HashSet<String>, out: &mut Vec<Section>) {
        if !vistos.insert(rel.to_string()) {
            return;
        }
        let propias = por_archivo.remove(rel).unwrap_or_default();
        let hijos: Vec<(u32, String)> = ix
            .files
            .get(rel)
            .into_iter()
            .flatten()
            .filter(|e| matches!(e.kind, EdgeKind::Input | EdgeKind::Include | EdgeKind::Subfile | EdgeKind::Import | EdgeKind::Part))
            .filter_map(|e| e.target.clone().filter(|t| t.to_lowercase().ends_with(".tex")).map(|t| (e.line, t)))
            .collect();
        let (mut i, mut j) = (0, 0);
        while i < propias.len() || j < hijos.len() {
            if j < hijos.len() && (i >= propias.len() || hijos[j].0 <= propias[i].line) {
                expandir(ix, &hijos[j].1, por_archivo, vistos, out);
                j += 1;
            } else {
                out.push(propias[i].clone());
                i += 1;
            }
        }
    }
    let mut por_archivo: HashMap<String, Vec<Section>> = HashMap::new();
    for s in todas {
        por_archivo.entry(s.file.clone()).or_default().push(s);
    }
    let mut out = Vec::new();
    expandir(ix, &ix.root_file, &mut por_archivo, &mut HashSet::new(), &mut out);
    out
}

const OCULTAS: [&str; 5] = [".lv", ".git", "node_modules", "figuras-cache", "target"];
const IMAGENES: [&str; 6] = ["png", "jpg", "jpeg", "pdf", "eps", "svg"];
const LIMITE_ARCHIVOS: usize = 6000;

fn recorrer(root: &Path, rel: &str, nivel: u32, out: &mut Vec<FileEntry>) {
    let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
    let mut hijos: Vec<_> = rd.flatten().collect();
    hijos.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for e in hijos {
        if out.len() >= LIMITE_ARCHIVOS {
            return;
        }
        let nombre = e.file_name().to_string_lossy().to_string();
        let rel_hijo = if rel.is_empty() { nombre.clone() } else { format!("{rel}/{nombre}") };
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            if !OCULTAS.contains(&nombre.as_str()) && !nombre.starts_with(".lvtmp-") && nivel < 8 {
                recorrer(root, &rel_hijo, nivel + 1, out);
            }
        } else {
            let ext = nombre.rsplit_once('.').map(|(_, x)| x.to_lowercase()).unwrap_or_default();
            let kind = match ext.as_str() {
                "tex" => "tex",
                "bib" => "bib",
                x if IMAGENES.contains(&x) => "image",
                _ => continue,
            };
            out.push(FileEntry { rel: rel_hijo, kind: kind.into() });
        }
    }
}

fn leer(root: &Path, rel: &str) -> Option<String> {
    let bytes = std::fs::read(root.join(rel)).ok()?;
    Some(String::from_utf8_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes)).into_owned())
}

fn problema(sev: Severity, kind: &str, msg: String, file: &str, line: u32) -> Problem {
    Problem { severity: sev, kind: kind.into(), message: msg, file: Some(file.into()), line: Some(line), line_end: None, context: String::new() }
}

/// Entornos cuyo contenido no se interpreta: un `\begin` adentro no es de LaTeX.
const LITERALES: [&str; 6] = ["verbatim", "Verbatim", "lstlisting", "minted", "comment", "verbatim*"];

impl Symbols {
    /// Recorre los archivos que alcanza el grafo desde la raíz, más los `.bib` que ese grafo nombra y los que haya en el árbol.
    pub fn build(root: &Path, ix: &ProjectIndex) -> Symbols {
        let t0 = Instant::now();
        let mut s = Symbols::default();
        recorrer(root, "", 0, &mut s.files);

        // Los `.tex` en el orden del grafo (el de lectura del documento): primero la raíz, después lo que va trayendo.
        let mut orden: Vec<String> = Vec::new();
        let mut vistos = HashSet::new();
        fn visitar(ix: &ProjectIndex, rel: &str, orden: &mut Vec<String>, vistos: &mut HashSet<String>) {
            if !vistos.insert(rel.to_string()) {
                return;
            }
            orden.push(rel.to_string());
            for e in ix.files.get(rel).into_iter().flatten() {
                if let Some(t) = &e.target {
                    if t.to_lowercase().ends_with(".tex") {
                        visitar(ix, t, orden, vistos);
                    }
                }
            }
        }
        visitar(ix, &ix.root_file, &mut orden, &mut vistos);

        let mut bibitems: HashSet<String> = HashSet::new();
        let mut contexto_previo: Vec<String> = Vec::new();
        for rel in &orden {
            let Some(texto) = leer(root, rel) else { continue };
            contexto_previo.clear();
            let lineas: Vec<&str> = texto.lines().collect();
            let mut pila: Vec<(String, u32)> = Vec::new();
            let mut literal: Option<String> = None;
            for c in escanear(&texto) {
                let Some(arg) = c.args.first().map(|a| a.trim().to_string()) else { continue };
                if let Some(env) = &literal {
                    if c.nombre == "end" && &arg == env {
                        literal = None;
                    } else {
                        continue;
                    }
                }
                if arg.contains('#') && !matches!(c.nombre.as_str(), "section" | "chapter" | "part") {
                    continue; // parámetro de macro
                }
                let cmd = c.nombre.as_str();
                match cmd {
                    "label" => {
                        let texto_linea = lineas.get(c.linea as usize - 1).copied().unwrap_or("");
                        let sin = texto_linea.replace(&format!("\\label{{{arg}}}"), "");
                        let mut contexto = recortar(&titulo_legible(sin_comentario(&sin)), 110);
                        if contexto.is_empty() {
                            contexto = lineas[..(c.linea as usize - 1)]
                                .iter()
                                .rev()
                                .map(|l| titulo_legible(sin_comentario(l)))
                                .find(|l| !l.is_empty())
                                .map(|l| recortar(&l, 110))
                                .unwrap_or_default();
                        }
                        s.labels.push(Label { name: arg, file: rel.clone(), line: c.linea, context: contexto });
                    }
                    "bibitem" => {
                        bibitems.insert(arg);
                    }
                    "begin" => {
                        if LITERALES.contains(&arg.as_str()) {
                            literal = Some(arg.clone());
                        }
                        pila.push((arg, c.linea));
                    }
                    "end" => {
                        // `document` puede abrirse en un archivo y cerrarse en otro; no se marca.
                        if arg == "document" {
                            continue;
                        }
                        match pila.iter().rposition(|(n, _)| *n == arg) {
                            Some(k) if k == pila.len() - 1 => {
                                pila.pop();
                            }
                            Some(k) => {
                                // Los abiertos encima de este quedaron sin cerrar.
                                let (tope, l) = pila[pila.len() - 1].clone();
                                s.lint.push(problema(Severity::Error, "lint-env", format!("\\end{{{arg}}} cierra con \\begin{{{tope}}} (línea {l}) todavía abierto"), rel, c.linea));
                                pila.truncate(k);
                            }
                            None => {
                                let m = match pila.iter().rev().find(|(n, _)| n != "document") {
                                    Some((tope, l)) => format!("\\end{{{arg}}} no coincide con \\begin{{{tope}}} de la línea {l}"),
                                    None => format!("\\end{{{arg}}} sin su \\begin"),
                                };
                                s.lint.push(problema(Severity::Error, "lint-env", m, rel, c.linea));
                            }
                        }
                    }
                    n if REFS.contains(&n) => {
                        for nombre in arg.split(',').map(str::trim).filter(|x| !x.is_empty()) {
                            s.refs.push(Use { name: nombre.into(), command: cmd.into(), file: rel.clone(), line: c.linea });
                        }
                    }
                    n if CITAS.contains(&n) => {
                        for nombre in arg.split(',').map(str::trim).filter(|x| !x.is_empty() && *x != "*") {
                            s.cites.push(Use { name: nombre.into(), command: cmd.into(), file: rel.clone(), line: c.linea });
                        }
                    }
                    n if SECCIONES.contains(&n) => {
                        // `\section*{...}` también está en el esquema; el título puede traer `\label`.
                        let level = SECCIONES.iter().position(|x| *x == n).unwrap_or(2) as u8;
                        let titulo = recortar(&titulo_legible(c.opciones.first().map_or(&arg, |o| if o.trim().is_empty() { &arg } else { &arg })), 120);
                        let _ = c.estrella;
                        s.sections.push(Section { level, title: titulo, file: rel.clone(), line: c.linea, label: None });
                    }
                    "newcommand" | "renewcommand" | "providecommand" | "NewDocumentCommand" | "RenewDocumentCommand" | "DeclareDocumentCommand" | "ProvideDocumentCommand" | "DeclareMathOperator" | "def" => {
                        let nombre = arg.trim_start_matches('\\').to_string();
                        if nombre.is_empty() {
                            continue;
                        }
                        let args = c.opciones.first().and_then(|o| o.trim().parse::<u8>().ok()).unwrap_or(0);
                        let kind = if cmd == "DeclareMathOperator" { "operator" } else if cmd == "def" { "def" } else { "command" };
                        s.defs.push(Def { name: nombre, kind: kind.into(), file: rel.clone(), line: c.linea, args });
                    }
                    "newenvironment" | "renewenvironment" | "newtheorem" | "newtcolorbox" => {
                        let kind = match cmd {
                            "newtheorem" => "theorem",
                            "newtcolorbox" => "tcolorbox",
                            _ => "environment",
                        };
                        let args = c.opciones.first().and_then(|o| o.trim().parse::<u8>().ok()).unwrap_or(0);
                        s.defs.push(Def { name: arg, kind: kind.into(), file: rel.clone(), line: c.linea, args });
                    }
                    _ => {}
                }
            }
            for (env, l) in pila.into_iter().filter(|(e, _)| e != "document") {
                s.lint.push(problema(Severity::Error, "lint-env", format!("\\begin{{{env}}} sin su \\end"), rel, l));
            }
        }

        // Las `.bib`: todas las del árbol (el grafo nombra algunas por `\bibliography`, pero el autocompletado las quiere todas).
        let bibs: Vec<String> = s.files.iter().filter(|f| f.kind == "bib").map(|f| f.rel.clone()).collect();
        for rel in bibs {
            if let Some(t) = leer(root, &rel) {
                s.bib.extend(parse_bib(&t, &rel));
            }
        }

        s.sections = ordenar_secciones(ix, std::mem::take(&mut s.sections));

        // La etiqueta de cada sección: la primera de su archivo en las 4 líneas que siguen, antes de la sección que viene.
        let por_archivo: BTreeMap<&str, Vec<&Label>> = s.labels.iter().fold(BTreeMap::new(), |mut m, l| {
            m.entry(l.file.as_str()).or_default().push(l);
            m
        });
        let siguientes: Vec<Option<u32>> = (0..s.sections.len())
            .map(|i| s.sections[i + 1..].iter().find(|o| o.file == s.sections[i].file).map(|o| o.line))
            .collect();
        for (i, sec) in s.sections.iter_mut().enumerate() {
            let tope = siguientes[i].unwrap_or(u32::MAX);
            sec.label = por_archivo
                .get(sec.file.as_str())
                .and_then(|ls| ls.iter().find(|l| l.line >= sec.line && l.line <= sec.line + 4 && l.line < tope))
                .map(|l| l.name.clone());
        }

        s.lint_global(&bibitems);
        s.scan_ms = t0.elapsed().as_millis() as u64;
        s
    }

    /// Lo que se ve con todo el proyecto a la vista: etiquetas repetidas, `\ref` y citas sin destino.
    fn lint_global(&mut self, bibitems: &HashSet<String>) {
        let mut primera: HashMap<&str, &Label> = HashMap::new();
        let mut nuevos = Vec::new();
        for l in &self.labels {
            match primera.get(l.name.as_str()) {
                Some(p) => nuevos.push(problema(Severity::Warning, "lint-label-duplicada", format!("la etiqueta «{}» ya está en {}:{}", l.name, p.file, p.line), &l.file, l.line)),
                None => {
                    primera.insert(l.name.as_str(), l);
                }
            }
        }
        for u in &self.refs {
            if !primera.contains_key(u.name.as_str()) {
                nuevos.push(problema(Severity::Warning, "lint-ref", format!("\\{}{{{}}}: no hay ninguna etiqueta con ese nombre", u.command, u.name), &u.file, u.line));
            }
        }
        // Las citas sólo se miran si el proyecto tiene dónde buscarlas.
        if !self.bib.is_empty() || !bibitems.is_empty() {
            let claves: HashSet<&str> = self.bib.iter().map(|b| b.key.as_str()).chain(bibitems.iter().map(String::as_str)).collect();
            for u in &self.cites {
                if !claves.contains(u.name.as_str()) {
                    nuevos.push(problema(Severity::Warning, "lint-cita", format!("\\{}{{{}}}: no hay ninguna entrada con esa clave", u.command, u.name), &u.file, u.line));
                }
            }
        }
        self.lint.extend(nuevos);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proyecto(archivos: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, texto) in archivos {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, texto).unwrap();
        }
        d
    }

    fn simbolos(d: &tempfile::TempDir, raiz: &str) -> Symbols {
        let ix = ProjectIndex::build(d.path(), raiz, &["include".to_string()]);
        Symbols::build(d.path(), &ix)
    }

    #[test]
    fn etiquetas_con_contexto_comentarios_y_parametros_de_macro() {
        let d = proyecto(&[(
            "main.tex",
            "\\section{Uno}\\label{sec:uno}\nTexto con ecuación\n\\begin{equation}\\label{eq:a} x=1 \\end{equation}\n% \\label{comentada}\n\\newcommand{\\foo}[1]{\\label{#1} \\ref{#1}}\n\\label{sec:sola}\n",
        )]);
        let s = simbolos(&d, "main.tex");
        let nombres: Vec<_> = s.labels.iter().map(|l| (l.name.as_str(), l.line)).collect();
        assert_eq!(nombres, [("sec:uno", 1), ("eq:a", 3), ("sec:sola", 6)], "sin la comentada ni la del cuerpo de la macro");
        assert_eq!(s.labels[0].context, "Uno", "el título de la sección, sin el \\label ni el comando");
        assert!(s.labels[1].context.contains("x=1"), "{:?}", s.labels[1].context);
        // Una etiqueta sola en su línea toma la línea anterior con texto.
        assert!(s.labels[2].context.contains("newcommand") || !s.labels[2].context.is_empty());
        assert!(s.refs.is_empty(), "el \\ref de la definición no es del documento");
    }

    #[test]
    fn usos_y_citas_con_varias_claves_y_argumentos_opcionales() {
        let d = proyecto(&[(
            "main.tex",
            "Ver \\cref{a,b} y \\eqref{c}, \\cite[p.~3]{k1, k2} \\parencite*{k3} \\ref*{d}\n\\nocite{*}\n",
        )]);
        let s = simbolos(&d, "main.tex");
        assert_eq!(s.refs.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c", "d"]);
        assert_eq!(s.cites.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["k1", "k2", "k3"], "`*` de \\nocite no es una clave");
        assert_eq!(s.refs[0].command, "cref");
        assert_eq!(s.cites[1].command, "cite");
    }

    #[test]
    fn secciones_en_el_orden_del_grafo_con_su_etiqueta() {
        let d = proyecto(&[
            ("main.tex", "\\chapter{Primero}\n\\label{cap:uno}\n\\input{sub}\n\\section*{Final \\emph{raro}}\n"),
            ("sub.tex", "\\section{Del archivo}\n\\label{sec:sub}\n\\subsection{Otra}\nTexto\n\n\n\n\\label{lejos}\n"),
        ]);
        let s = simbolos(&d, "main.tex");
        let v: Vec<_> = s.sections.iter().map(|x| (x.level, x.title.as_str(), x.file.as_str(), x.label.as_deref())).collect();
        assert_eq!(
            v,
            [
                (1, "Primero", "main.tex", Some("cap:uno")),
                (2, "Del archivo", "sub.tex", Some("sec:sub")),
                (3, "Otra", "sub.tex", None), // `lejos` está a más de 4 líneas... y antes no hay otra
                (2, "Final raro", "main.tex", None),
            ]
        );
    }

    #[test]
    fn definiciones_se_saltan_enteras_y_se_registran() {
        let d = proyecto(&[(
            "main.tex",
            "\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand\\suelto[2]{#1 \\begin{x} #2}\n\\renewcommand{\\vec}[1][3]{\\mathbf{#1}}\n\\DeclareMathOperator{\\sn}{sn}\n\\newenvironment{caja}[1]{\\begin{center}\\textbf{#1}}{\\end{center}}\n\\newtheorem{teo}{Teorema}\n\\def\\viejo#1#2{#1#2}\n\\begin{caja}{a}\\RR\\end{caja}\n",
        )]);
        let s = simbolos(&d, "main.tex");
        let v: Vec<_> = s.defs.iter().map(|x| (x.name.as_str(), x.kind.as_str(), x.line, x.args)).collect();
        assert_eq!(
            v,
            [
                ("RR", "command", 1, 0),
                ("suelto", "command", 2, 2),
                ("vec", "command", 3, 1),
                ("sn", "operator", 4, 0),
                ("caja", "environment", 5, 1),
                ("teo", "theorem", 6, 0),
                ("viejo", "def", 7, 0),
            ]
        );
        assert!(s.lint.iter().all(|p| p.kind != "lint-env"), "los \\begin de los cuerpos no desbalancean: {:#?}", s.lint);
    }

    #[test]
    fn bib_con_llaves_comillas_comentarios_y_entradas_rotas() {
        let t = "@comment{ignorado}\n@string{x = \"y\"}\n\n@book{real,\n  author = {Autora, Una and Otro, Dos},\n  title = {Un {Libro} que \\emph{existe}},\n  year = 2020,\n}\n\n@article{con-comillas,\n  author = \"Pérez, Juan\",\n  title = \"Otro\" # \" mas\",\n  date = {2019-05-01}\n}\n\n@book{roto,\n  author = {Nadie}\n  title = {sin coma}\n}\n";
        let v = parse_bib(t, "refs.bib");
        let k: Vec<_> = v.iter().map(|b| (b.key.as_str(), b.kind.as_str(), b.line)).collect();
        assert_eq!(k, [("real", "book", 4), ("con-comillas", "article", 10), ("roto", "book", 16)]);
        assert_eq!(v[0].author, "Autora, Una and Otro, Dos");
        assert_eq!(v[0].title, "Un Libro que existe");
        assert_eq!(v[0].year, "2020");
        assert_eq!(v[1].author, "Pérez, Juan");
        assert_eq!(v[1].year, "2019");
        assert_eq!(v[2].author, "Nadie", "la entrada rota se indexa igual: el autocompletado la ofrece");
    }

    #[test]
    fn lint_de_entornos_desbalanceados_y_literales() {
        let d = proyecto(&[(
            "main.tex",
            "\\begin{document}\n\\begin{itemize}\n\\item a\n\\begin{enumerate}\n\\item b\n\\end{itemize}\n\\end{center}\n\\begin{verbatim}\n\\begin{falso} y \\end{otro}\n\\end{verbatim}\n\\begin{abierto}\n",
        )]);
        let s = simbolos(&d, "main.tex");
        let v: Vec<_> = s.lint.iter().filter(|p| p.kind == "lint-env").map(|p| (p.line.unwrap(), p.message.clone())).collect();
        assert_eq!(v.len(), 3, "{v:#?}");
        assert!(v[0].1.contains("end{itemize}") && v[0].1.contains("begin{enumerate}") && v[0].0 == 6, "{:?}", v[0]);
        assert!(v[1].1.contains("end{center}") && v[1].0 == 7);
        assert!(v[2].1.contains("begin{abierto}") && v[2].0 == 11);
        // El `document` abierto no se marca (puede cerrarse en otro archivo).
        assert!(!v.iter().any(|(_, m)| m.contains("document")));
    }

    #[test]
    fn lint_de_etiquetas_duplicadas_refs_y_citas_sin_destino() {
        let d = proyecto(&[
            ("main.tex", "\\label{a}\n\\input{otro}\n\\ref{a} \\ref{falta} \\cite{real,fantasma}\n"),
            ("otro.tex", "\\label{a}\n\\label{b}\n"),
            ("refs.bib", "@book{real, title={x}}\n"),
        ]);
        let s = simbolos(&d, "main.tex");
        let v: Vec<_> = s.lint.iter().map(|p| (p.kind.as_str(), p.file.clone().unwrap(), p.line.unwrap())).collect();
        assert!(v.contains(&("lint-label-duplicada", "otro.tex".into(), 1)), "{v:?}");
        assert!(v.contains(&("lint-ref", "main.tex".into(), 3)));
        assert!(v.contains(&("lint-cita", "main.tex".into(), 3)));
        assert_eq!(s.lint.iter().filter(|p| p.kind == "lint-cita").count(), 1, "`real` sí está");
        assert_eq!(s.lint.iter().filter(|p| p.kind == "lint-ref").count(), 1, "`a` sí está");
        assert!(s.lint.iter().find(|p| p.kind == "lint-ref").unwrap().message.contains("falta"));
    }

    #[test]
    fn sin_bib_ni_bibitems_las_citas_no_se_marcan_pero_con_bibitem_si() {
        let d = proyecto(&[("main.tex", "\\cite{x}\n")]);
        assert!(simbolos(&d, "main.tex").lint.is_empty());
        let d = proyecto(&[("main.tex", "\\cite{x,y}\n\\begin{thebibliography}{9}\n\\bibitem{x} Algo\n\\end{thebibliography}\n")]);
        let s = simbolos(&d, "main.tex");
        assert_eq!(s.lint.len(), 1, "{:#?}", s.lint);
        assert!(s.lint[0].message.contains("{y}"));
    }

    #[test]
    fn la_lista_de_archivos_trae_tex_bib_e_imagenes_sin_lo_que_no_va() {
        let d = proyecto(&[
            ("main.tex", ""),
            ("Secciones/uno.tex", ""),
            ("refs.bib", ""),
            ("img/foto.png", "x"),
            ("img/otra.PDF", "x"),
            ("figuras-cache/x.pdf", "x"),
            (".lv/build/a.tex", ""),
            ("notas.txt", ""),
        ]);
        let s = simbolos(&d, "main.tex");
        let v: Vec<_> = s.files.iter().map(|f| (f.rel.as_str(), f.kind.as_str())).collect();
        assert!(v.contains(&("Secciones/uno.tex", "tex")) && v.contains(&("refs.bib", "bib")) && v.contains(&("img/foto.png", "image")) && v.contains(&("img/otra.PDF", "image")));
        assert!(!v.iter().any(|(r, _)| r.starts_with("figuras-cache") || r.starts_with(".lv") || r.ends_with(".txt")), "{v:?}");
    }

    #[test]
    fn los_numeros_de_linea_siguen_bien_despues_de_cuerpos_de_varias_lineas() {
        let d = proyecto(&[("main.tex", "\\newcommand{\\a}{\n uno\n dos\n}\n\\label{despues}\n\n\n\\section{Titulo}\n")]);
        let s = simbolos(&d, "main.tex");
        assert_eq!(s.labels[0].line, 5);
        assert_eq!(s.sections[0].line, 8);
    }
}
