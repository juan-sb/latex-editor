//! Grafo de inclusión y partes del proyecto (4.3 del plan).
//!
//! Se recorre desde la raíz siguiendo `\input`, `\include`, `\subfile` e `\import`. Las **partes** son las entradas de
//! primer nivel hechas con los comandos de `parts.commands`, en el orden en que aparecen en el documento: en el libro
//! son los `\Capitulo{...}` de `libro_cuerpo.tex`, que entra por `\input` desde la raíz, así que no alcanza con mirar la
//! raíz. El nombre de una parte es el argumento tal cual (`Secciones/Desnormalización`), que es lo que lleva
//! `\includeonly`.
//!
//! No es un parser de TeX: busca los comandos con sus argumentos entre llaves, ignora los comentarios y descarta los
//! argumentos que son parámetros de macro (`\input{#1}` dentro de la definición de `\Capitulo`). Alcanza para decidir
//! qué archivos pertenecen a qué parte; lo que se le escape es un archivo que no aparece, no un build roto.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Input,
    Include,
    Subfile,
    Import,
    Graphics,
    Bib,
    /// Un comando de `parts.commands` que no es de los de arriba (`\Capitulo`).
    Part,
}

impl EdgeKind {
    fn estructural(self) -> bool {
        matches!(self, EdgeKind::Input | EdgeKind::Include | EdgeKind::Subfile | EdgeKind::Import | EdgeKind::Part)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub kind: EdgeKind,
    pub command: String,
    /// El argumento como está escrito (sin comillas).
    pub raw: String,
    /// El archivo que resuelve, relativo a la raíz y con `/`, si existe.
    pub target: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Part {
    /// Lo que va en `\includeonly`.
    pub name: String,
    /// Su archivo, si existe.
    pub file: Option<String>,
    pub command: String,
    /// Archivo y línea donde aparece el comando.
    pub source: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Affects {
    /// El archivo entra en lo que compila el perfil.
    Yes,
    /// Es de una parte que el perfil no incluye.
    OtherPart(String),
    /// No está en el grafo desde la raíz.
    Unrelated,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectIndex {
    pub root_file: String,
    /// Aristas de cada `.tex` leído.
    pub files: BTreeMap<String, Vec<Edge>>,
    pub parts: Vec<Part>,
    /// Todo lo que se alcanza desde la raíz (`.tex`, imágenes, `.bib`).
    pub reachable: BTreeSet<String>,
    /// hijo → quién lo trae por una arista estructural.
    parents: BTreeMap<String, Vec<String>>,
    pub scan_ms: u64,
}

// --- lectura de los comandos -------------------------------------------------------------------------------------------

/// Texto sin lo que sigue a un `%` que no esté escapado (`\%` es un porcentaje; `\\%` es salto de línea y comentario).
pub(crate) fn sin_comentario(linea: &str) -> &str {
    let mut barras = 0;
    for (i, c) in linea.char_indices() {
        if c == '\\' {
            barras += 1;
            continue;
        }
        if c == '%' && barras % 2 == 0 {
            return &linea[..i];
        }
        barras = 0;
    }
    linea
}

struct Crudo {
    comando: String,
    args: Vec<String>,
    linea: u32,
}

fn cantidad_de_argumentos(c: &str) -> usize {
    match c {
        "import" | "subimport" => 2,
        _ => 1,
    }
}

const MAX_ARGUMENTO: usize = 2000;

/// Argumento entre llaves que empieza en `b[i]` (que tiene que ser `{`). Devuelve el contenido y la posición siguiente.
fn argumento(b: &[u8], texto: &str, i: usize) -> Option<(String, usize)> {
    if b.get(i) != Some(&b'{') {
        return None;
    }
    let mut prof = 0;
    let mut j = i;
    while j < b.len() && j - i < MAX_ARGUMENTO {
        match b[j] {
            b'\\' => j += 1, // lo que sigue a una barra no abre ni cierra nada
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

fn saltar_blancos(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn escanear(texto: &str, interesantes: &HashSet<&str>) -> Vec<Crudo> {
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
                    i += 2; // `\\`, `\%`, `\{`...
                    continue;
                }
                let ini = i + 1;
                let mut j = ini;
                while j < b.len() && b[j].is_ascii_alphabetic() {
                    j += 1;
                }
                let nombre = &limpio[ini..j];
                i = j;
                if !interesantes.contains(nombre) {
                    continue;
                }
                let mut k = saltar_blancos(b, j);
                if b.get(k) == Some(&b'*') {
                    k += 1;
                }
                // Argumentos opcionales: `\includegraphics[width=3cm]{x}`.
                loop {
                    k = saltar_blancos(b, k);
                    if b.get(k) != Some(&b'[') {
                        break;
                    }
                    match limpio[k..].find(']') {
                        Some(f) if f < MAX_ARGUMENTO => k += f + 1,
                        _ => break,
                    }
                }
                let mut args = Vec::new();
                for _ in 0..cantidad_de_argumentos(nombre) {
                    k = saltar_blancos(b, k);
                    match argumento(b, &limpio, k) {
                        Some((a, sig)) => {
                            args.push(a);
                            k = sig;
                        }
                        None => break,
                    }
                }
                if args.len() == cantidad_de_argumentos(nombre) {
                    out.push(Crudo { comando: nombre.to_string(), args, linea });
                }
            }
            _ => i += 1,
        }
    }
    out
}

// --- resolución de rutas -----------------------------------------------------------------------------------------------

fn normalizar(raw: &str) -> Option<String> {
    let s = raw.trim().trim_matches('"').trim().replace('\\', "/");
    let s = s.strip_prefix("./").unwrap_or(&s).to_string();
    if s.is_empty() || s.starts_with('/') || s.contains(':') || s.split('/').any(|c| c == "..") {
        return None;
    }
    Some(s)
}

fn existe(root: &Path, rel: &str) -> bool {
    root.join(rel).is_file()
}

fn resolver_tex(root: &Path, raw: &str) -> Option<String> {
    let base = normalizar(raw)?;
    let con_ext = if base.to_lowercase().ends_with(".tex") { base.clone() } else { format!("{base}.tex") };
    [con_ext, base].into_iter().find(|c| existe(root, c))
}

fn resolver_imagen(root: &Path, raw: &str) -> Option<String> {
    let base = normalizar(raw)?;
    std::iter::once(base.clone())
        .chain(["pdf", "png", "jpg", "jpeg", "eps", "svg"].iter().map(|e| format!("{base}.{e}")))
        .find(|c| existe(root, c))
}

fn resolver_bib(root: &Path, raw: &str) -> Option<String> {
    let base = normalizar(raw)?;
    let c = if base.to_lowercase().ends_with(".bib") { base } else { format!("{base}.bib") };
    existe(root, &c).then_some(c)
}

/// Nombre de la parte tal como lo lleva `\includeonly`: el argumento, con `/` y sin la extensión `.tex`.
fn nombre_de_parte(raw: &str) -> Option<String> {
    let n = normalizar(raw)?;
    Some(n.strip_suffix(".tex").map(str::to_string).unwrap_or(n))
}

fn leer_texto(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let sin_bom = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    Some(String::from_utf8_lossy(sin_bom).into_owned())
}

// --- el índice ---------------------------------------------------------------------------------------------------------

impl ProjectIndex {
    /// Recorre el proyecto desde `root_file`. Un archivo que no se puede leer se salta: el índice es una ayuda, no
    /// puede impedir abrir ni compilar.
    pub fn build(root: &Path, root_file: &str, commands: &[String]) -> ProjectIndex {
        let t0 = Instant::now();
        let mut ix = ProjectIndex { root_file: root_file.to_string(), ..Default::default() };
        let mut interesantes: HashSet<&str> =
            ["input", "include", "subfile", "import", "subimport", "includegraphics", "bibliography", "addbibresource"].into_iter().collect();
        interesantes.extend(commands.iter().map(String::as_str));
        let cmds: HashSet<&str> = commands.iter().map(String::as_str).collect();
        let mut visitados = HashSet::new();
        ix.visitar(root, root_file, false, &interesantes, &cmds, &mut visitados);
        ix.scan_ms = t0.elapsed().as_millis() as u64;
        ix
    }

    fn visitar(&mut self, root: &Path, rel: &str, en_parte: bool, interesantes: &HashSet<&str>, cmds: &HashSet<&str>, vistos: &mut HashSet<String>) {
        if !vistos.insert(rel.to_string()) {
            return;
        }
        self.reachable.insert(rel.to_string());
        let Some(texto) = leer_texto(&root.join(rel)) else { return };
        let mut aristas = Vec::new();
        for c in escanear(&texto, interesantes) {
            let (kind, args): (EdgeKind, Vec<String>) = match c.comando.as_str() {
                "includegraphics" => (EdgeKind::Graphics, c.args),
                "bibliography" => (EdgeKind::Bib, c.args[0].split(',').map(|s| s.trim().to_string()).collect()),
                "addbibresource" => (EdgeKind::Bib, c.args),
                "import" | "subimport" => (EdgeKind::Import, vec![format!("{}/{}", c.args[0].trim().trim_end_matches('/'), c.args[1].trim())]),
                "input" => (EdgeKind::Input, c.args),
                "include" => (EdgeKind::Include, c.args),
                "subfile" => (EdgeKind::Subfile, c.args),
                _ => (EdgeKind::Part, c.args),
            };
            for raw in args {
                // `\input{#1}` y compañía: parámetros de macro, no archivos.
                if raw.is_empty() || raw.contains('#') || raw.contains('\\') {
                    continue;
                }
                let raw = raw.trim().trim_matches('"').to_string();
                let target = match kind {
                    EdgeKind::Graphics => resolver_imagen(root, &raw),
                    EdgeKind::Bib => resolver_bib(root, &raw),
                    _ => resolver_tex(root, &raw),
                };
                aristas.push(Edge { kind, command: c.comando.clone(), raw, target, line: c.linea });
            }
        }
        self.files.insert(rel.to_string(), aristas.clone());
        for e in aristas {
            if let Some(t) = &e.target {
                self.reachable.insert(t.clone());
                if e.kind.estructural() {
                    self.parents.entry(t.clone()).or_default().push(rel.to_string());
                }
            }
            let es_parte = cmds.contains(e.command.as_str()) && !en_parte;
            if es_parte {
                if let Some(name) = nombre_de_parte(&e.raw) {
                    // La misma parte dos veces (por ejemplo en un `\if`) cuenta una.
                    if !self.parts.iter().any(|p| p.name == name) {
                        self.parts.push(Part { name, file: e.target.clone(), command: e.command.clone(), source: rel.to_string(), line: e.line });
                    }
                }
            }
            if let (true, Some(t)) = (e.kind.estructural(), &e.target) {
                if t.to_lowercase().ends_with(".tex") {
                    self.visitar(root, t, en_parte || es_parte, interesantes, cmds, vistos);
                }
            }
        }
    }

    pub fn part_names(&self) -> Vec<String> {
        self.parts.iter().map(|p| p.name.clone()).collect()
    }

    /// Índice de la parte a la que pertenece `rel`: ella misma si lo es, o la parte que la trae (recursivo, la más
    /// cercana). `None` para lo que no es de ninguna parte (el preámbulo, `libro_cuerpo.tex`, una portada).
    pub fn part_of(&self, rel: &str) -> Option<usize> {
        let mut cola = vec![rel.to_string()];
        let mut vistos = HashSet::new();
        while !cola.is_empty() {
            let mut siguiente = Vec::new();
            for f in cola {
                if !vistos.insert(f.clone()) {
                    continue;
                }
                if let Some(i) = self.parts.iter().position(|p| p.file.as_deref() == Some(f.as_str())) {
                    return Some(i);
                }
                if let Some(ps) = self.parents.get(&f) {
                    siguiente.extend(ps.iter().cloned());
                }
            }
            cola = siguiente;
        }
        None
    }

    /// Si guardar `rel` cambia lo que compila un perfil que incluye `seleccion` (`None` = todas las partes).
    pub fn affects(&self, rel: &str, seleccion: Option<&[String]>) -> Affects {
        if !self.reachable.contains(rel) {
            return Affects::Unrelated;
        }
        match (self.part_of(rel), seleccion) {
            (None, _) | (Some(_), None) => Affects::Yes,
            (Some(i), Some(sel)) => {
                if sel.iter().any(|s| *s == self.parts[i].name) {
                    Affects::Yes
                } else {
                    Affects::OtherPart(self.parts[i].name.clone())
                }
            }
        }
    }

    /// Carpetas donde `\include` escribe sus `.aux` dentro del directorio de salida (`Secciones`, `Capítulos/Desarrollo`).
    /// MiKTeX las crea solo; TeX Live no (S1): se crean antes por portabilidad.
    pub fn include_dirs(&self, commands: &[String]) -> BTreeSet<String> {
        let mut dirs = BTreeSet::new();
        let nombres = self
            .files
            .values()
            .flatten()
            .filter(|e| e.kind == EdgeKind::Include || commands.iter().any(|c| *c == e.command))
            .filter_map(|e| nombre_de_parte(&e.raw));
        for n in nombres {
            if let Some((dir, _)) = n.rsplit_once('/') {
                dirs.insert(dir.to_string());
            }
        }
        dirs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmds(c: &[&str]) -> Vec<String> {
        c.iter().map(|s| s.to_string()).collect()
    }

    fn escanear_todo(t: &str) -> Vec<(String, Vec<String>, u32)> {
        let i: HashSet<&str> = ["input", "include", "import", "includegraphics", "Capitulo"].into_iter().collect();
        escanear(t, &i).into_iter().map(|c| (c.comando, c.args, c.linea)).collect()
    }

    #[test]
    fn los_comentarios_no_cuentan_pero_el_porcentaje_escapado_si_es_texto() {
        assert_eq!(sin_comentario("a % b"), "a ");
        assert_eq!(sin_comentario("100\\% seguro"), "100\\% seguro");
        assert_eq!(sin_comentario("\\\\% comentario"), "\\\\");
        let r = escanear_todo("%\\include{a}\n\\input{b} % \\input{c}\n\\input{d}\\%\\input{e}");
        let args: Vec<_> = r.iter().map(|x| x.1[0].as_str()).collect();
        assert_eq!(args, ["b", "d", "e"]);
    }

    #[test]
    fn lee_argumentos_con_espacios_tildes_llaves_y_opciones() {
        let r = escanear_todo(
            "\\include{Capítulos/Introducción general}\n\\input {x}\n\\includegraphics[width=3cm, scale=1]{img/a b}\n\\Capitulo*{Secciones/Uno}\n\\import{dir/}{f}",
        );
        assert_eq!(r[0].1, ["Capítulos/Introducción general"]);
        assert_eq!(r[1].1, ["x"]);
        assert_eq!(r[2].1, ["img/a b"]);
        assert_eq!((r[3].0.as_str(), r[3].1[0].as_str(), r[3].2), ("Capitulo", "Secciones/Uno", 4));
        assert_eq!(r[4].1, ["dir/", "f"]);
        // Llaves anidadas y un comando sin argumento no rompen nada.
        let r = escanear_todo("\\input{a{b}c}\n\\input\n\\include{z}");
        assert_eq!(r.iter().map(|x| x.1[0].as_str()).collect::<Vec<_>>(), ["a{b}c", "z"]);
    }

    #[test]
    fn dos_barras_y_comandos_parecidos_no_se_confunden() {
        // `\includeonly` y `\inputencoding` no son `\include` ni `\input`.
        let r = escanear_todo("\\includeonly{a}\n\\inputencoding{utf8}\n\\\\input{no}\n\\input{si}");
        assert_eq!(r.iter().map(|x| x.1[0].as_str()).collect::<Vec<_>>(), ["si"]);
    }

    fn proyecto(archivos: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, texto) in archivos {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, texto).unwrap();
        }
        d
    }

    /// El libro en chiquito: la raíz trae `libro_cuerpo.tex` por `\input`, y ahí están los `\Capitulo`.
    fn libro_chico() -> tempfile::TempDir {
        proyecto(&[
            ("main.tex", "\\documentclass{book}\n\\input{structure}\n\\begin{document}\n\\input{libro_cuerpo}\n\\end{document}\n"),
            ("structure.tex", "\\newcommand{\\Capitulo}[1]{\\clearpage\\include{#1}}\n\\newcommand{\\Otra}[1]{\\input{#1}}\n"),
            (
                "libro_cuerpo.tex",
                "\\Capitulo{Secciones/Uno}\n\\Capitulo{Secciones/Dos}\n%\\Capitulo{Secciones/Comentado}\n\\input{Secciones/Prueba}\n\\Capitulo{Secciones/Tres}\n",
            ),
            ("Secciones/Uno.tex", "uno \\input{Secciones/fig_a} \\includegraphics{img/foto}\n\\cite{x}\n"),
            ("Secciones/fig_a.tex", "figura\n"),
            ("Secciones/Dos.tex", "dos \\input{Secciones/Anexo}\n"),
            ("Secciones/Anexo.tex", "anexo \\input{Secciones/fig_a}\n"),
            ("Secciones/Tres.tex", "tres\n"),
            ("Secciones/Prueba.tex", "prueba\n"),
            ("Secciones/Suelto.tex", "nadie lo incluye\n"),
            ("img/foto.png", "x"),
        ])
    }

    #[test]
    fn las_partes_salen_en_orden_aunque_esten_en_un_archivo_que_entra_por_input() {
        let d = libro_chico();
        let ix = ProjectIndex::build(d.path(), "main.tex", &cmds(&["include", "Capitulo"]));
        assert_eq!(ix.part_names(), ["Secciones/Uno", "Secciones/Dos", "Secciones/Tres"], "sin el comentado ni el \\input suelto");
        assert_eq!(ix.parts[0].file.as_deref(), Some("Secciones/Uno.tex"));
        assert_eq!((ix.parts[0].source.as_str(), ix.parts[0].line), ("libro_cuerpo.tex", 1));
        assert_eq!(ix.parts[0].command, "Capitulo");
    }

    #[test]
    fn sin_los_comandos_de_parte_el_capitulo_es_un_input_mas() {
        let d = libro_chico();
        let ix = ProjectIndex::build(d.path(), "main.tex", &cmds(&["include"]));
        assert!(ix.parts.is_empty(), "`\\include{{#1}}` de la definición de \\Capitulo es un parámetro, no una parte");
    }

    #[test]
    fn la_parte_de_un_archivo_es_ella_misma_o_la_que_lo_trae() {
        let d = libro_chico();
        let ix = ProjectIndex::build(d.path(), "main.tex", &cmds(&["include", "Capitulo"]));
        let nombre = |rel: &str| ix.part_of(rel).map(|i| ix.parts[i].name.clone());
        assert_eq!(nombre("Secciones/Uno.tex").as_deref(), Some("Secciones/Uno"));
        assert_eq!(nombre("Secciones/fig_a.tex").as_deref(), Some("Secciones/Uno"), "una figura va con el capítulo que la trae");
        assert_eq!(nombre("Secciones/Anexo.tex").as_deref(), Some("Secciones/Dos"), "recursivo: Dos trae a Anexo");
        assert_eq!(nombre("libro_cuerpo.tex"), None);
        assert_eq!(nombre("structure.tex"), None);
        assert_eq!(nombre("Secciones/Prueba.tex"), None, "un \\input fuera de las partes es global");
        assert_eq!(nombre("Secciones/Suelto.tex"), None);
    }

    #[test]
    fn que_archivos_cambian_lo_que_compila_un_perfil() {
        let d = libro_chico();
        let ix = ProjectIndex::build(d.path(), "main.tex", &cmds(&["include", "Capitulo"]));
        let sel = vec!["Secciones/Uno".to_string()];
        assert_eq!(ix.affects("Secciones/Uno.tex", Some(&sel)), Affects::Yes);
        assert_eq!(ix.affects("Secciones/fig_a.tex", Some(&sel)), Affects::Yes);
        assert_eq!(ix.affects("Secciones/Dos.tex", Some(&sel)), Affects::OtherPart("Secciones/Dos".into()));
        assert_eq!(ix.affects("structure.tex", Some(&sel)), Affects::Yes, "el preámbulo afecta a todo");
        assert_eq!(ix.affects("Secciones/Dos.tex", None), Affects::Yes, "perfil con todas las partes");
        assert_eq!(ix.affects("Secciones/Suelto.tex", None), Affects::Unrelated);
        assert_eq!(ix.affects("no-existe.tex", None), Affects::Unrelated);
    }

    #[test]
    fn el_grafo_resuelve_imagenes_y_extensiones_omitidas() {
        let d = libro_chico();
        let ix = ProjectIndex::build(d.path(), "main.tex", &cmds(&["Capitulo"]));
        let uno = &ix.files["Secciones/Uno.tex"];
        let img = uno.iter().find(|e| e.kind == EdgeKind::Graphics).unwrap();
        assert_eq!(img.target.as_deref(), Some("img/foto.png"));
        assert!(ix.reachable.contains("img/foto.png"));
        assert!(!ix.reachable.contains("Secciones/Suelto.tex"));
    }

    #[test]
    fn las_carpetas_de_include_salen_de_los_nombres_de_las_partes() {
        let d = libro_chico();
        let c = cmds(&["include", "Capitulo"]);
        let ix = ProjectIndex::build(d.path(), "main.tex", &c);
        assert_eq!(ix.include_dirs(&c).into_iter().collect::<Vec<_>>(), ["Secciones"]);
        let d2 = proyecto(&[
            ("main.tex", "\\documentclass{book}\n\\include{Capítulos/Uno}\n\\include{Capítulos/Desarrollo/Dos}\n\\include{plano}\n"),
            ("Capítulos/Uno.tex", ""),
            ("Capítulos/Desarrollo/Dos.tex", ""),
            ("plano.tex", ""),
        ]);
        let c = cmds(&["include"]);
        let ix = ProjectIndex::build(d2.path(), "main.tex", &c);
        assert_eq!(ix.part_names(), ["Capítulos/Uno", "Capítulos/Desarrollo/Dos", "plano"]);
        assert_eq!(ix.include_dirs(&c).into_iter().collect::<Vec<_>>(), ["Capítulos", "Capítulos/Desarrollo"]);
    }

    #[test]
    fn los_ciclos_y_los_archivos_ausentes_no_cuelgan_ni_rompen() {
        let d = proyecto(&[("a.tex", "\\input{b}\n\\input{falta}\n"), ("b.tex", "\\input{a}\n\\input{../afuera}\n")]);
        let ix = ProjectIndex::build(d.path(), "a.tex", &cmds(&["include"]));
        assert!(ix.reachable.contains("b.tex"));
        let faltante = ix.files["a.tex"].iter().find(|e| e.raw == "falta").unwrap();
        assert!(faltante.target.is_none());
        assert!(ix.files["b.tex"].iter().find(|e| e.raw == "../afuera").unwrap().target.is_none(), "`..` no se resuelve");
        let sin_raiz = ProjectIndex::build(d.path(), "no-existe.tex", &cmds(&["include"]));
        assert!(sin_raiz.parts.is_empty());
    }

    #[test]
    fn un_bom_al_principio_no_estorba() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.tex"), b"\xEF\xBB\xBF\\include{b}\n").unwrap();
        std::fs::write(d.path().join("b.tex"), "x").unwrap();
        let ix = ProjectIndex::build(d.path(), "a.tex", &cmds(&["include"]));
        assert_eq!(ix.part_names(), ["b"]);
    }
}
