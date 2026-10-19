//! Búsqueda y reemplazo en el proyecto (6.6 del plan), línea por línea con el crate `regex`.
//!
//! - Por defecto sólo los archivos del grafo (`.tex`) y los `.bib`; con `all_files`, todo el árbol de texto (sin `.lv`,
//!   `.git`, `figuras-cache`, binarios ni archivos de más de 2 MB).
//! - Las columnas salen en unidades UTF-16, que es como cuenta el editor (un `ñ` es 1, un emoji es 2).
//! - Se lee con `fsio::read_file` (texto normalizado a `\n`) y se escribe con `fsio::write_file`: el reemplazo conserva el EOL y
//!   el BOM de cada archivo y falla con un conflicto si el archivo cambió entre la lectura y la escritura. Un archivo con EOL
//!   mezclados se salta (no se puede reescribir sin alterar líneas que no se tocaron, como en 10.2).

use crate::error::{Error, Result};
use crate::fsio;
use crate::graph::ProjectIndex;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

pub const MAX_COINCIDENCIAS: usize = 5000;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const OCULTAS: [&str; 5] = [".lv", ".git", "node_modules", "figuras-cache", "target"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Todo el árbol de texto, no sólo los archivos del grafo y los `.bib`.
    pub all_files: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { query: String::new(), regex: false, case_sensitive: false, whole_word: false, all_files: false }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Match {
    /// 1..N.
    pub line: u32,
    /// Posición de la coincidencia en la línea, en unidades UTF-16.
    pub col: u32,
    pub len: u32,
    /// La línea (recortada si es muy larga, con la coincidencia adentro).
    pub text: String,
    /// Dónde empieza `text` dentro de la línea (0 si no se recortó); la coincidencia está en `col - offset`.
    pub offset: u32,
    /// Sólo en una vista previa de reemplazo: lo que quedaría en lugar de la coincidencia.
    pub replaced: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileMatches {
    pub file: String,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub total: usize,
    /// Se llegó al tope de coincidencias (`MAX_COINCIDENCIAS`): hay más.
    pub truncated: bool,
    pub files_scanned: usize,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplaceReport {
    /// Archivo y cuántas coincidencias se reemplazaron.
    pub changed: Vec<(String, usize)>,
    /// Los que no se tocaron y por qué.
    pub skipped: Vec<(String, String)>,
    pub total: usize,
}

fn compilar(o: &SearchOptions) -> Result<Regex> {
    if o.query.is_empty() {
        return Err(Error::Other("la búsqueda está vacía".into()));
    }
    let base = if o.regex { o.query.clone() } else { regex::escape(&o.query) };
    let patron = if o.whole_word { format!(r"\b(?:{base})\b") } else { base };
    RegexBuilder::new(&patron)
        .case_insensitive(!o.case_sensitive)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| Error::Other(format!("expresión regular inválida: {}", e.to_string().lines().last().unwrap_or(""))))
}

/// Los archivos donde se busca, relativos a la raíz y con `/`.
pub fn archivos(root: &Path, ix: &ProjectIndex, todos: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if todos {
        fn rec(root: &Path, rel: &str, nivel: u32, out: &mut Vec<String>) {
            let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
            let mut hijos: Vec<_> = rd.flatten().collect();
            hijos.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
            for e in hijos {
                let nombre = e.file_name().to_string_lossy().to_string();
                let r = if rel.is_empty() { nombre.clone() } else { format!("{rel}/{nombre}") };
                let Ok(t) = e.file_type() else { continue };
                if t.is_dir() {
                    if !OCULTAS.contains(&nombre.as_str()) && !nombre.starts_with(".lvtmp-") && nivel < 10 {
                        rec(root, &r, nivel + 1, out);
                    }
                } else if e.metadata().is_ok_and(|m| m.len() <= MAX_BYTES) {
                    out.push(r);
                }
            }
        }
        rec(root, "", 0, &mut out);
    } else {
        out.extend(ix.reachable.iter().filter(|r| r.to_lowercase().ends_with(".tex") || r.to_lowercase().ends_with(".bib")).cloned());
        // Las `.bib` del árbol: el grafo sólo conoce las que nombra `\bibliography`.
        let mut bibs: Vec<String> = Vec::new();
        fn rec_bib(root: &Path, rel: &str, nivel: u32, out: &mut Vec<String>) {
            let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
            for e in rd.flatten() {
                let nombre = e.file_name().to_string_lossy().to_string();
                let r = if rel.is_empty() { nombre.clone() } else { format!("{rel}/{nombre}") };
                let Ok(t) = e.file_type() else { continue };
                if t.is_dir() {
                    if !OCULTAS.contains(&nombre.as_str()) && !nombre.starts_with(".lvtmp-") && nivel < 6 {
                        rec_bib(root, &r, nivel + 1, out);
                    }
                } else if nombre.to_lowercase().ends_with(".bib") {
                    out.push(r);
                }
            }
        }
        rec_bib(root, "", 0, &mut bibs);
        for b in bibs {
            if !out.contains(&b) {
                out.push(b);
            }
        }
        out.sort_by_key(|s| s.to_lowercase());
    }
    out
}

const RECORTE: usize = 220;

fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Busca en un texto ya normalizado a `\n`. `reemplazo`: si viene, cada coincidencia lleva lo que quedaría.
fn buscar_en(texto: &str, re: &Regex, reemplazo: Option<&str>, restante: usize) -> Vec<Match> {
    let mut out = Vec::new();
    for (i, linea) in texto.split('\n').enumerate() {
        for m in re.find_iter(linea) {
            if out.len() >= restante {
                return out;
            }
            // Una coincidencia vacía (`a*` en una línea sin `a`) no es una coincidencia que valga mostrar.
            if m.start() == m.end() {
                continue;
            }
            let col = utf16(&linea[..m.start()]);
            let len = utf16(m.as_str());
            // Una línea larga (un párrafo de 500 caracteres) se recorta alrededor de la coincidencia.
            let (texto_linea, offset) = if linea.chars().count() > RECORTE {
                let antes: Vec<(usize, char)> = linea[..m.start()].char_indices().collect();
                let desde = antes.len().saturating_sub(70);
                let ini_byte = antes.get(desde).map_or(0, |(b, _)| *b);
                let fin_byte = linea[m.start()..].char_indices().nth(RECORTE - 70).map_or(linea.len(), |(b, _)| m.start() + b);
                (linea[ini_byte..fin_byte.max(m.end())].to_string(), utf16(&linea[..ini_byte]))
            } else {
                (linea.to_string(), 0)
            };
            let replaced = reemplazo.map(|r| re.replace(m.as_str(), r).into_owned());
            out.push(Match { line: i as u32 + 1, col, len, text: texto_linea, offset, replaced });
        }
    }
    out
}

pub fn search(root: &Path, ix: &ProjectIndex, o: &SearchOptions, reemplazo: Option<&str>) -> Result<SearchResult> {
    let t0 = Instant::now();
    let re = compilar(o)?;
    let reemplazo_real = reemplazo.map(|r| if o.regex { r.to_string() } else { r.replace('$', "$$") });
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut leidos = 0usize;
    let mut truncated = false;
    for rel in archivos(root, ix, o.all_files) {
        // Un archivo que no es texto (binario, UTF-16, UTF-8 inválido) no se busca.
        let Ok(r) = fsio::read_file(root, &rel) else { continue };
        leidos += 1;
        let m = buscar_en(&r.text, &re, reemplazo_real.as_deref(), MAX_COINCIDENCIAS - total);
        total += m.len();
        if !m.is_empty() {
            files.push(FileMatches { file: rel, matches: m });
        }
        if total >= MAX_COINCIDENCIAS {
            truncated = true;
            break;
        }
    }
    Ok(SearchResult { files, total, truncated, files_scanned: leidos, ms: t0.elapsed().as_millis() as u64 })
}

/// Reemplaza todas las coincidencias en los archivos pedidos (o en todos los que tengan). Cada archivo se reescribe con su EOL
/// y su BOM; los que cambiaron en disco entre la lectura y la escritura, o que mezclan EOL, quedan sin tocar y se informan.
pub fn replace(root: &Path, ix: &ProjectIndex, o: &SearchOptions, reemplazo: &str, solo: Option<&[String]>) -> Result<ReplaceReport> {
    let re = compilar(o)?;
    let rep = if o.regex { reemplazo.to_string() } else { reemplazo.replace('$', "$$") };
    let mut rep_out = ReplaceReport { changed: Vec::new(), skipped: Vec::new(), total: 0 };
    for rel in archivos(root, ix, o.all_files) {
        if solo.is_some_and(|s| !s.iter().any(|x| *x == rel)) {
            continue;
        }
        let Ok(r) = fsio::read_file(root, &rel) else { continue };
        let n = r.text.split('\n').map(|l| re.find_iter(l).filter(|m| m.start() != m.end()).count()).sum::<usize>();
        if n == 0 {
            continue;
        }
        if r.mixed {
            rep_out.skipped.push((rel, "mezcla tipos de salto de línea: se abre en sólo lectura y no se reescribe".into()));
            continue;
        }
        let nuevo = r.text.split('\n').map(|l| re.replace_all(l, rep.as_str()).into_owned()).collect::<Vec<_>>().join("\n");
        match fsio::write_file(root, &rel, &nuevo, Some(&r.version)) {
            Ok(_) => {
                rep_out.total += n;
                rep_out.changed.push((rel, n));
            }
            Err(Error::Conflict { .. }) => rep_out.skipped.push((rel, "cambió en disco mientras se reemplazaba".into())),
            Err(e) => rep_out.skipped.push((rel, e.to_string())),
        }
    }
    Ok(rep_out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proyecto(archivos: &[(&str, &[u8])]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, b) in archivos {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b).unwrap();
        }
        d
    }

    fn opts(q: &str) -> SearchOptions {
        SearchOptions { query: q.into(), ..Default::default() }
    }

    fn buscar(d: &tempfile::TempDir, o: &SearchOptions) -> SearchResult {
        let ix = ProjectIndex::build(d.path(), "main.tex", &["include".to_string()]);
        search(d.path(), &ix, o, None).unwrap()
    }

    fn base() -> tempfile::TempDir {
        proyecto(&[
            ("main.tex", b"Uno dos tres\n\\input{cap}\nfin Dos DOS\n"),
            ("cap.tex", "El capítulo dos habla de ñandúes y 😀 dos veces: dos.\n".as_bytes()),
            ("suelto.tex", b"dos que nadie incluye\n"),
            ("refs.bib", b"@book{dos, title={Dos}}\n"),
            ("datos.bin", b"dos\0dos\0"),
            ("notas.txt", b"dos en un txt\n"),
        ])
    }

    #[test]
    fn busca_sin_distinguir_mayusculas_en_los_archivos_del_grafo_y_los_bib() {
        let d = base();
        let r = buscar(&d, &opts("dos"));
        let v: Vec<_> = r.files.iter().map(|f| (f.file.as_str(), f.matches.len())).collect();
        assert_eq!(v, [("cap.tex", 3), ("main.tex", 3), ("refs.bib", 2)], "sin suelto.tex (no está en el grafo), el binario ni el txt");
        assert_eq!(r.total, 8);
        assert!(!r.truncated);
    }

    #[test]
    fn mayusculas_y_palabra_completa() {
        let d = base();
        let o = SearchOptions { case_sensitive: true, ..opts("Dos") };
        assert_eq!(buscar(&d, &o).total, 2, "main.tex y el título del .bib");
        // Palabra completa: "ñand" no cuenta dentro de "ñandúes", pero sí sin la opción.
        let o = SearchOptions { whole_word: true, ..opts("ñand") };
        assert_eq!(buscar(&d, &o).total, 0);
        assert_eq!(buscar(&d, &opts("ñand")).total, 1);
        let o = SearchOptions { whole_word: true, ..opts("dos") };
        assert_eq!(buscar(&d, &o).total, 8, "las ocho son la palabra suelta");
    }

    #[test]
    fn las_columnas_son_utf16_como_las_del_editor() {
        let d = base();
        let r = buscar(&d, &SearchOptions { case_sensitive: true, ..opts("dos veces") });
        let m = &r.files[0].matches[0];
        // "El capítulo dos habla de ñandúes y 😀 dos veces: dos." : el emoji ocupa 2 unidades.
        let linea = "El capítulo dos habla de ñandúes y 😀 dos veces: dos.";
        let esperado = linea.encode_utf16().take_while(|_| true).count() as u32; // sólo para fijar la forma de contar
        assert!(esperado > 0);
        let col_utf16 = linea[..linea.find("dos veces").unwrap()].encode_utf16().count() as u32;
        assert_eq!((m.line, m.col, m.len), (1, col_utf16, "dos veces".len() as u32));
        assert!(col_utf16 > linea[..linea.find("dos veces").unwrap()].chars().count() as u32, "el emoji suma una unidad más que los caracteres");
    }

    #[test]
    fn regex_con_capturas_y_expresion_invalida() {
        let d = base();
        let o = SearchOptions { regex: true, ..opts(r"(\w+) dos") };
        let r = buscar(&d, &o);
        assert!(r.total >= 2);
        let e = search(d.path(), &ProjectIndex::build(d.path(), "main.tex", &[]), &SearchOptions { regex: true, ..opts("a(b") }, None).unwrap_err();
        assert!(e.to_string().contains("expresión regular inválida"), "{e}");
        assert!(search(d.path(), &ProjectIndex::build(d.path(), "main.tex", &[]), &opts(""), None).is_err());
    }

    #[test]
    fn con_todo_el_arbol_entra_el_archivo_suelto_y_el_txt_pero_no_el_binario() {
        let d = base();
        let r = buscar(&d, &SearchOptions { all_files: true, ..opts("dos") });
        let nombres: Vec<_> = r.files.iter().map(|f| f.file.as_str()).collect();
        assert!(nombres.contains(&"suelto.tex") && nombres.contains(&"notas.txt"), "{nombres:?}");
        assert!(!nombres.contains(&"datos.bin"), "tiene NUL: no es texto");
    }

    #[test]
    fn una_linea_larga_se_recorta_alrededor_de_la_coincidencia() {
        let larga = format!("{} AQUI {}", "a".repeat(400), "b".repeat(400));
        let d = proyecto(&[("main.tex", larga.as_bytes())]);
        let r = buscar(&d, &SearchOptions { case_sensitive: true, ..opts("AQUI") });
        let m = &r.files[0].matches[0];
        assert!(m.text.chars().count() < 260 && m.text.contains("AQUI"), "{}", m.text.len());
        assert_eq!(m.col, 401);
        assert_eq!(m.col - m.offset, m.text.find("AQUI").unwrap() as u32, "col y offset dicen dónde está en el texto recortado");
    }

    #[test]
    fn el_tope_de_coincidencias_se_informa() {
        let d = proyecto(&[("main.tex", "x ".repeat(6000).as_bytes())]);
        let r = buscar(&d, &opts("x"));
        assert!(r.truncated);
        assert_eq!(r.total, MAX_COINCIDENCIAS);
    }

    fn reemplazar(d: &tempfile::TempDir, o: &SearchOptions, con: &str, solo: Option<&[String]>) -> ReplaceReport {
        let ix = ProjectIndex::build(d.path(), "main.tex", &["include".to_string()]);
        replace(d.path(), &ix, o, con, solo).unwrap()
    }

    #[test]
    fn el_reemplazo_conserva_crlf_bom_y_la_falta_de_salto_final() {
        let d = proyecto(&[
            ("main.tex", b"\xEF\xBB\xBFuno dos\r\n\\input{b}\r\ndos"),
            ("b.tex", b"dos\ndos sin cambios de formato\n"),
        ]);
        let r = reemplazar(&d, &opts("dos"), "TRES", None);
        assert_eq!(r.total, 4);
        assert_eq!(std::fs::read(d.path().join("main.tex")).unwrap(), b"\xEF\xBB\xBFuno TRES\r\n\\input{b}\r\nTRES");
        assert_eq!(std::fs::read(d.path().join("b.tex")).unwrap(), b"TRES\nTRES sin cambios de formato\n");
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn vista_previa_con_capturas_y_dolares_literales() {
        let d = proyecto(&[("main.tex", b"valor=3 y valor=45\n")]);
        let ix = ProjectIndex::build(d.path(), "main.tex", &[]);
        let o = SearchOptions { regex: true, ..opts(r"valor=(\d+)") };
        let r = search(d.path(), &ix, &o, Some("v:$1")).unwrap();
        let rep: Vec<_> = r.files[0].matches.iter().map(|m| m.replaced.clone().unwrap()).collect();
        assert_eq!(rep, ["v:3", "v:45"]);
        // Sin regex, el `$` del reemplazo es un `$` y no una captura.
        let r = search(d.path(), &ix, &opts("valor"), Some("$1")).unwrap();
        assert_eq!(r.files[0].matches[0].replaced.as_deref(), Some("$1"));
        reemplazar(&d, &opts("valor"), "$1", None);
        assert_eq!(std::fs::read_to_string(d.path().join("main.tex")).unwrap(), "$1=3 y $1=45\n");
    }

    #[test]
    fn solo_los_archivos_pedidos_y_los_de_eol_mezclado_se_saltan() {
        let d = proyecto(&[
            ("main.tex", b"dos\n\\input{a}\n\\input{b}\n"),
            ("a.tex", b"dos\n"),
            ("b.tex", b"dos\r\ndos\ndos\r\n"), // EOL mezclados
        ]);
        let r = reemplazar(&d, &opts("dos"), "X", Some(&["a.tex".to_string(), "b.tex".to_string()]));
        assert_eq!(r.changed, [("a.tex".to_string(), 1)]);
        assert_eq!(r.skipped.len(), 1);
        assert!(r.skipped[0].0 == "b.tex" && r.skipped[0].1.contains("mezcla"));
        assert_eq!(std::fs::read(d.path().join("main.tex")).unwrap(), b"dos\n\\input{a}\n\\input{b}\n", "main.tex no estaba en la lista");
        assert_eq!(std::fs::read(d.path().join("b.tex")).unwrap(), b"dos\r\ndos\ndos\r\n", "el mezclado queda como estaba, byte a byte");
    }

    #[test]
    fn un_archivo_que_no_es_utf8_no_rompe_la_busqueda() {
        let d = proyecto(&[("main.tex", b"dos \xFF\xFE roto\n\\input{ok}\n"), ("ok.tex", b"dos\n")]);
        let r = buscar(&d, &opts("dos"));
        assert_eq!(r.files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), ["ok.tex"], "el UTF-8 inválido se salta entero");
    }
}
