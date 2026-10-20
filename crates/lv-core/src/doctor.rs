//! El doctor (9 del plan, F8): qué falta o qué está mal en la máquina o en el proyecto antes de que un build falle de una forma
//! difícil de entender. Se corre al abrir un proyecto por primera vez y a pedido. Sólo mira: **no cambia nada** de la máquina, del
//! antivirus ni del proyecto; cada hallazgo dice qué pasa y, si hay, cómo se arregla.
//!
//! Dos mitades. Las **herramientas** (`chequeos_de_herramientas`) lanzan procesos de verdad (`pdflatex --version`, un documento mínimo,
//! `latexmk` con un `-e` que imprime su `PATH`...) a través de una `Sonda`, así las pruebas le pasan salidas falsas (una distribución
//! vieja, un lanzador roto con `0xC0000135`). Los **chequeos de proyecto** (`chequeos_de_proyecto`) leen archivos.

use crate::config::ProjectConfig;
use crate::graph::ProjectIndex;
use crate::historial::Entrada as Linea;
use crate::procesos::ProcesoTex;
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Nivel {
    Ok,
    Info,
    Aviso,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hallazgo {
    pub id: String,
    pub nivel: Nivel,
    pub titulo: String,
    pub detalle: String,
    /// Cómo se arregla, si se sabe.
    pub arreglo: Option<String>,
    /// El archivo (relativo a la raíz) y la línea, si el hallazgo es de un archivo del proyecto.
    pub archivo: Option<String>,
    pub linea: Option<u32>,
}

impl Hallazgo {
    fn nuevo(id: &str, nivel: Nivel, titulo: impl Into<String>, detalle: impl Into<String>) -> Self {
        Hallazgo { id: id.into(), nivel, titulo: titulo.into(), detalle: detalle.into(), arreglo: None, archivo: None, linea: None }
    }
    fn con_arreglo(mut self, a: impl Into<String>) -> Self {
        self.arreglo = Some(a.into());
        self
    }
    fn en(mut self, archivo: &str, linea: u32) -> Self {
        self.archivo = Some(archivo.into());
        self.linea = Some(linea);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Informe {
    pub hallazgos: Vec<Hallazgo>,
    pub ms: u64,
    /// «MiKTeX 26.5» o «TeX Live 2024», si se pudo saber.
    pub distribucion: Option<String>,
}

// --- las sondas ---------------------------------------------------------------------------------------------------------------

/// Lo que dio un programa lanzado por el doctor.
#[derive(Debug, Clone, Default)]
pub struct Salida {
    /// `None`: no está en el `PATH` (o no se pudo lanzar).
    pub lanzado: bool,
    pub codigo: Option<i32>,
    pub texto: String,
    /// Pasó el límite de tiempo y se lo mató.
    pub colgado: bool,
}

/// Cómo se lanza un programa en el doctor: nombre, argumentos y, si hace falta, una carpeta donde correr.
pub type Sonda<'a> = dyn Fn(&str, &[&str], Option<&Path>) -> Salida + Sync + 'a;

/// El código con el que Windows termina un proceso al que le falta una DLL: lo que dejan los lanzadores de una instalación de MiKTeX a medias.
pub const DLL_NO_ENCONTRADA: i32 = 0xC000_0135u32 as i32;

pub const TIEMPO_MAXIMO: Duration = Duration::from_secs(20);

/// La sonda de verdad: lanza el programa, junta su salida y lo mata si pasa de `TIEMPO_MAXIMO`.
pub fn sonda_real(nombre: &str, args: &[&str], cwd: Option<&Path>) -> Salida {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(nombre);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(mut hijo) = cmd.spawn() else { return Salida::default() };
    let (mut o, mut e) = (hijo.stdout.take(), hijo.stderr.take());
    let lector = |r: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(mut r) = r {
                let _ = std::io::Read::read_to_end(&mut r, &mut b);
            }
            String::from_utf8_lossy(&b).into_owned()
        })
    };
    let (ho, he) = (lector(o.take().map(|x| Box::new(x) as _)), lector(e.take().map(|x| Box::new(x) as _)));
    let t0 = Instant::now();
    let (codigo, colgado) = loop {
        match hijo.try_wait() {
            Ok(Some(s)) => break (s.code(), false),
            Ok(None) if t0.elapsed() > TIEMPO_MAXIMO => {
                let _ = hijo.kill();
                let _ = hijo.wait();
                break (None, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break (None, false),
        }
    };
    let texto = format!("{}{}", ho.join().unwrap_or_default(), he.join().unwrap_or_default());
    Salida { lanzado: true, codigo, texto, colgado }
}

// --- herramientas -------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Distro {
    MiKTeX,
    TeXLive,
    Otra,
}

fn distro_de(texto: &str) -> (Distro, Option<String>) {
    static MIK: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static TL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let mik = MIK.get_or_init(|| Regex::new(r"MiKTeX[ -](\d+(?:\.\d+)*)").expect("patrón válido"));
    let tl = TL.get_or_init(|| Regex::new(r"TeX Live (\d{4})").expect("patrón válido"));
    if let Some(c) = mik.captures(texto) {
        return (Distro::MiKTeX, Some(format!("MiKTeX {}", &c[1])));
    }
    if let Some(c) = tl.captures(texto) {
        return (Distro::TeXLive, Some(format!("TeX Live {}", &c[1])));
    }
    (Distro::Otra, None)
}

/// La fecha del núcleo de LaTeX (`\fmtversion`: `2026-06-01`) de la salida de un documento mínimo.
fn fecha_del_nucleo(texto: &str) -> Option<(u32, u32, u32)> {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"LVFMT:(\d{4})[-/](\d{2})[-/](\d{2})").expect("patrón válido"));
    let c = re.captures(texto)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?))
}

fn primera_linea(t: &str) -> String {
    t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(160).collect()
}

/// ¿El programa no arranca porque el lanzador está roto (falta una DLL)?
fn roto(s: &Salida) -> bool {
    s.lanzado && s.codigo == Some(DLL_NO_ENCONTRADA)
}

fn hallazgo_roto(id: &str, programa: &str) -> Hallazgo {
    Hallazgo::nuevo(
        id,
        Nivel::Error,
        format!("{programa} no arranca (0xC0000135)"),
        format!("El lanzador de {programa} sale con 0xC0000135, que es «falta una DLL»: es lo que deja una instalación de MiKTeX a medias."),
    )
    .con_arreglo("Reparar o reinstalar MiKTeX (MiKTeX Console, «Tasks», «Check for problems»), y volver a abrir el proyecto.")
}

/// Un programa que el proyecto necesita (o no): `hallazgo` de si está y arranca.
fn programa(id: &str, nombre: &str, args: &[&str], necesario: bool, por_que: &str, sonda: &Sonda, ok_texto: impl Fn(&Salida) -> String) -> Hallazgo {
    let s = sonda(nombre, args, None);
    if !s.lanzado {
        let nivel = if necesario { Nivel::Error } else { Nivel::Info };
        return Hallazgo::nuevo(id, nivel, format!("No se encontró {nombre}"), por_que.to_string()).con_arreglo(format!("Instalar {nombre} y dejarlo en el PATH (o reabrir la aplicación después de instalarlo)."));
    }
    if roto(&s) {
        return hallazgo_roto(id, nombre);
    }
    if s.colgado {
        return Hallazgo::nuevo(id, Nivel::Aviso, format!("{nombre} no contestó a tiempo"), format!("Pasaron {} s sin que termine: puede estar esperando algo (un instalador de paquetes, una ventana).", TIEMPO_MAXIMO.as_secs()));
    }
    Hallazgo::nuevo(id, Nivel::Ok, format!("{nombre}: {}", ok_texto(&s)), "")
}

/// Todo lo que se puede saber de las herramientas de TeX. `engine` es el de `latexviewer.json`; `usa_*` dicen qué necesita el proyecto.
pub struct Necesidades<'a> {
    pub engine: &'a str,
    /// Algún perfil externaliza figuras (hace falta `-shell-escape`).
    pub externaliza: bool,
    pub usa_biber: bool,
    pub usa_bibtex: bool,
    pub usa_makeindex: bool,
    /// El proyecto tiene un `latexmkrc` (o `.latexmkrc`) en su raíz.
    pub latexmkrc: bool,
}

pub fn chequeos_de_herramientas(n: &Necesidades, sonda: &Sonda) -> (Vec<Hallazgo>, Option<String>) {
    let mut h = Vec::new();
    // El motor: distribución y versión, y que arranque de verdad.
    let v = sonda(n.engine, &["--version"], None);
    let (distro, nombre_distro) = distro_de(&v.texto);
    if !v.lanzado {
        h.push(
            Hallazgo::nuevo("motor", Nivel::Error, format!("No se encontró {}", n.engine), "Sin el motor de TeX no se puede compilar nada.")
                .con_arreglo("Instalar MiKTeX o TeX Live y dejar sus programas en el PATH."),
        );
        return (h, None);
    }
    if roto(&v) {
        h.push(hallazgo_roto("motor", n.engine));
        return (h, None);
    }
    h.push(Hallazgo::nuevo("motor", Nivel::Ok, format!("{}: {}", n.engine, nombre_distro.clone().unwrap_or_else(|| primera_linea(&v.texto))), ""));

    // Las demás sondas no dependen unas de otras y cada una lanza un proceso (biber solo tarda más de un segundo): corren a la vez. Medido
    // en esta máquina: 4,3 s en fila, el doctor entero tardaba 8,7 s al abrir el libro. Cada una con su carpeta del temporal, así los
    // programas que se lanzan con ella no ensucian el proyecto ni se pisan.
    static CONTADOR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let tmp = std::env::temp_dir().join(format!("lv-doctor-{}-{}", std::process::id(), CONTADOR.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let (dir_nucleo, dir_path) = (tmp.join("nucleo"), tmp.join("path"));
    let _ = std::fs::create_dir_all(&dir_nucleo);
    let _ = std::fs::create_dir_all(&dir_path);
    let _ = std::fs::write(dir_path.join("x.tex"), r"\documentclass{article}\begin{document}x\end{document}");
    let resultados: Vec<Vec<Hallazgo>> = std::thread::scope(|sc| {
        let hilos = vec![
            sc.spawn(|| sonda_del_nucleo(n, sonda, &dir_nucleo)),
            sc.spawn(|| sonda_de_max_print_line(n, sonda, distro)),
            sc.spawn(|| {
                vec![programa("latexmk", "latexmk", &["-v"], true, "La app compila con latexmk.", sonda, |s| {
                    let l = s.texto.lines().find(|l| l.contains("Version")).map(str::trim).unwrap_or("").to_string();
                    if l.is_empty() { primera_linea(&s.texto) } else { l }
                })]
            }),
            sc.spawn(|| {
                vec![programa("perl", "perl", &["-v"], true, "latexmk es un script de Perl: sin Perl no corre (en MiKTeX no viene incluido).", sonda, |s| {
                    s.texto.lines().find(|l| l.contains("This is perl")).map(str::trim).unwrap_or("").to_string()
                })]
            }),
            sc.spawn(|| sonda_del_path_de_latexmk(n, sonda, &dir_path)),
            sc.spawn(|| vec![programa("biber", "biber", &["--version"], n.usa_biber, "El proyecto usa `\\addbibresource`: la bibliografía la hace biber.", sonda, |s| primera_linea(&s.texto))]),
            sc.spawn(|| vec![programa("bibtex", "bibtex", &["--version"], n.usa_bibtex, "El proyecto usa `\\bibliography`: la bibliografía la hace bibtex.", sonda, |s| primera_linea(&s.texto))]),
            sc.spawn(|| vec![programa("makeindex", "makeindex", &["-h"], n.usa_makeindex, "El proyecto usa un índice alfabético.", sonda, |_| "responde".into())]),
            sc.spawn(|| sonda_de_synctex(sonda)),
        ];
        hilos.into_iter().map(|t| t.join().unwrap_or_default()).collect()
    });
    let _ = std::fs::remove_dir_all(&tmp);
    h.extend(resultados.into_iter().flatten());
    (h, nombre_distro)
}

/// El núcleo de LaTeX (los hooks `\AddToHook` que usan los drivers son de 2021-06) y `-shell-escape` (hace falta para cocinar las figuras).
fn sonda_del_nucleo(n: &Necesidades, sonda: &Sonda, dir: &Path) -> Vec<Hallazgo> {
    let mut h = Vec::new();
    let doc = r"\typeout{LVFMT:\fmtversion}\ifnum\pdfshellescape=1 \typeout{LVSE:1}\else\typeout{LVSE:0}\fi\stop";
    let m = sonda(n.engine, &["-interaction=nonstopmode", "-halt-on-error", "-shell-escape", doc], Some(dir));
    if roto(&m) {
        h.push(hallazgo_roto("nucleo", n.engine));
    } else if let Some((a, mes, dia)) = fecha_del_nucleo(&m.texto) {
        if (a, mes) < (2021, 6) {
            h.push(
                Hallazgo::nuevo(
                    "nucleo",
                    Nivel::Error,
                    format!("LaTeX {a}-{mes:02}-{dia:02} es más viejo que 2021-06"),
                    "Los drivers de la app usan hooks (`\\AddToHook`) que el núcleo de LaTeX trae desde 2021-06.",
                )
                .con_arreglo("Actualizar la distribución de TeX."),
            );
        } else {
            h.push(Hallazgo::nuevo("nucleo", Nivel::Ok, format!("LaTeX {a}-{mes:02}-{dia:02} (hace falta 2021-06 o más)"), ""));
        }
    } else {
        h.push(Hallazgo::nuevo("nucleo", Nivel::Aviso, "No se pudo leer la versión de LaTeX", format!("Un documento mínimo no dio la fecha del núcleo: {}", primera_linea(&m.texto))));
    }
    if n.externaliza {
        if m.texto.contains("LVSE:1") {
            h.push(Hallazgo::nuevo("shell-escape", Nivel::Ok, "-shell-escape está permitido", ""));
        } else if m.texto.contains("LVSE:0") {
            h.push(
                Hallazgo::nuevo("shell-escape", Nivel::Error, "-shell-escape no está permitido", "La externalización de figuras lanza pdflatex desde pdflatex y la distribución lo está bloqueando.")
                    .con_arreglo("En MiKTeX: activar «shell escape» en la configuración (shell_escape = t). En TeX Live: shell_escape = t en texmf.cnf."),
            );
        }
    }
    h
}

/// `-max-print-line`: sin él los logs salen cortados a 79 columnas. La app lo pasa también por entorno, así que sólo se informa.
fn sonda_de_max_print_line(n: &Necesidades, sonda: &Sonda, distro: Distro) -> Vec<Hallazgo> {
    let pl = sonda(n.engine, &["-max-print-line=10000", "--version"], None);
    if pl.lanzado && pl.codigo != Some(0) && !roto(&pl) {
        return vec![Hallazgo::nuevo(
            "max-print-line",
            if distro == Distro::TeXLive { Nivel::Info } else { Nivel::Aviso },
            format!("{} no acepta -max-print-line", n.engine),
            "Es lo que pasa con algunas versiones de TeX Live. La app también pone la variable de entorno max_print_line; si un error de un log sale cortado a 79 columnas, es esto.",
        )];
    }
    vec![]
}

/// El `PATH` que ve Perl adentro de latexmk: un `latexmkrc` no puede lanzar nada que no esté ahí. Con `-c x.tex` latexmk corre el código de
/// `-e` y sólo limpia (no compila nada). El código no lleva comillas: Windows se las come.
fn sonda_del_path_de_latexmk(n: &Necesidades, sonda: &Sonda, dir: &Path) -> Vec<Hallazgo> {
    let p = sonda("latexmk", &["-e", r"print qq(LVPATH=$ENV{PATH}\n);", "-c", "x.tex"], Some(dir));
    if let Some(linea) = p.texto.lines().find_map(|l| l.trim_end().strip_prefix("LVPATH=")) {
        // En Windows el separador es `;` (y `C:\` tiene dos puntos): sólo en un PATH de Unix se corta por `:`.
        let sep = if linea.contains(';') || linea.contains(":\\") { ';' } else { ':' };
        let entradas: Vec<&str> = linea.split(sep).filter(|x| !x.trim().is_empty()).collect();
        if entradas.len() <= 2 {
            // Es una propiedad de la máquina: sólo es un problema (aviso) si el proyecto tiene un `latexmkrc` que pueda lanzar algo por su nombre.
            return vec![Hallazgo::nuevo(
                "path-latexmk",
                if n.latexmkrc { Nivel::Aviso } else { Nivel::Info },
                format!("Dentro de latexmk el PATH tiene {} entrada{}", entradas.len(), if entradas.len() == 1 { "" } else { "s" }),
                format!(
                    "Perl ve «{}»: sólo el bin de la distribución, sin System32 ni PowerShell. Un `latexmkrc` que lance un programa por su nombre (`powershell`, `tasklist`) falla en silencio, aunque ande en la consola. {}",
                    linea.chars().take(120).collect::<String>(),
                    if n.latexmkrc { "Este proyecto tiene un `latexmkrc`." } else { "Este proyecto no tiene `latexmkrc`, así que no le afecta: la app lanza ella misma lo que no es TeX." }
                ),
            )
            .con_arreglo("En el latexmkrc, usar la ruta completa del programa (la de `$ENV{SystemRoot}`) en lugar de su nombre.")];
        }
        return vec![Hallazgo::nuevo("path-latexmk", Nivel::Ok, format!("El PATH adentro de latexmk tiene {} entradas", entradas.len()), "")];
    }
    if p.lanzado && !roto(&p) {
        return vec![Hallazgo::nuevo("path-latexmk", Nivel::Info, "No se pudo leer el PATH que ve latexmk", format!("La prueba no imprimió el PATH: {}", primera_linea(&p.texto)))];
    }
    vec![]
}

/// El CLI ya no hace falta (la app lee el `.synctex.gz` con su parser), pero sirve de oráculo y de respaldo.
fn sonda_de_synctex(sonda: &Sonda) -> Vec<Hallazgo> {
    let sy = sonda("synctex", &["help"], None);
    if !sy.lanzado {
        vec![Hallazgo::nuevo("synctex", Nivel::Info, "No se encontró synctex", "No hace falta: la app lee el SyncTeX con su propio parser. El programa sólo sirve para comparar.")]
    } else if roto(&sy) {
        vec![hallazgo_roto("synctex", "synctex")]
    } else {
        vec![Hallazgo::nuevo("synctex", Nivel::Ok, "synctex arranca", "")]
    }
}

// --- proyecto -----------------------------------------------------------------------------------------------------------------

fn sin_comentario(l: &str) -> &str {
    crate::graph::sin_comentario(l)
}

/// Un `\def\X` (o `\gdef`, `\edef`, `\xdef`) sin guardia de una variable declarada: pisa el valor que pone el driver antes de cargar la raíz.
pub(crate) fn defs_sin_guardia(texto: &str, nombre: &str) -> Vec<u32> {
    let def = Regex::new(&format!(r"\\[gex]?def\s*\\{}\b", regex::escape(nombre))).expect("patrón válido");
    let guardia = Regex::new(&format!(r"\\(?:ifdefined|@ifundefined|ifx|providecommand|IfFileExists|ifcsname)\b[^\n]*\\?{}\b|\\ifx\s*\\{}\s*\\(?:undefined|@undefined)", regex::escape(nombre), regex::escape(nombre))).expect("patrón válido");
    let lineas: Vec<&str> = texto.lines().collect();
    let mut v = Vec::new();
    for (i, l) in lineas.iter().enumerate() {
        let l = sin_comentario(l);
        if !def.is_match(l) {
            continue;
        }
        // Con guardia: en la misma línea o en alguna de las tres anteriores (`\ifdefined\X\else` / `\ifx\X\undefined` en la línea de arriba).
        let desde = i.saturating_sub(3);
        let guardada = guardia.is_match(l) || lineas[desde..i].iter().any(|p| guardia.is_match(sin_comentario(p)));
        if !guardada {
            v.push(i as u32 + 1);
        }
    }
    v
}

/// Cómo carga `texto` los archivos en las definiciones de `cmd` (un comando de `parts.commands`, `\Capitulo`): la línea de la primera
/// definición que lo hace por `\input` (o `\subfile`) y si alguna lo hace por `\include`. `\includeonly` sólo vale para `\include`: si
/// ninguna definición usa `\include`, un perfil de partes elegidas compila todo igual. Una definición con `\input` junto a otra con
/// `\include` (el libro: según `\CapitulosPorInput`, que sólo pone el driver de la cocción) no es un problema.
pub(crate) fn definiciones_de_parte(texto: &str, cmd: &str) -> (Option<u32>, bool) {
    let (mut por_input, mut con_include) = (None, false);
    let c = regex::escape(cmd);
    let def = Regex::new(&format!(
        r"\\(?:(?:re)?newcommand\*?|DeclareRobustCommand\*?|(?:New|Renew|Provide|Declare)DocumentCommand)\s*\{{?\s*\\{c}\s*\}}?|\\[gex]?def\s*\\{c}\b"
    ))
    .expect("patrón válido");
    for m in def.find_iter(texto) {
        // Después de la definición vienen los argumentos (`[1]`, y `{m}` en NewDocumentCommand) y el cuerpo: se miran los primeros dos
        // bloques `{...}` balanceados y el que mencione un comando de carga decide.
        let resto = &texto[m.end()..];
        let mut bloques: Vec<String> = Vec::new();
        let (mut prof, mut actual) = (0i32, String::new());
        for ch in resto.chars().take(2000) {
            match ch {
                '{' => prof += 1,
                '}' => prof -= 1,
                _ => {}
            }
            if prof > 0 || ch == '}' {
                actual.push(ch);
            }
            if prof == 0 && ch == '}' {
                bloques.push(std::mem::take(&mut actual));
                if bloques.len() == 2 {
                    break;
                }
            }
        }
        for cuerpo in &bloques {
            // `\include{`, no `\includegraphics` ni `\includepdf`.
            static INCLUDE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
            let include = INCLUDE.get_or_init(|| Regex::new(r"\\include\s*\{").expect("patrón válido"));
            if include.is_match(cuerpo) {
                con_include = true;
            } else if (cuerpo.contains("\\input") || cuerpo.contains("\\subfile")) && por_input.is_none() {
                por_input = Some(texto[..m.start()].matches('\n').count() as u32 + 1);
            }
        }
    }
    (por_input, con_include)
}

pub struct EntradaDeProyecto<'a> {
    pub root: &'a Path,
    pub root_file: &'a str,
    pub config: &'a ProjectConfig,
    pub ix: &'a ProjectIndex,
}

pub fn chequeos_de_proyecto(e: &EntradaDeProyecto) -> Vec<Hallazgo> {
    let mut h = Vec::new();
    let leer = |rel: &str| std::fs::read(e.root.join(rel)).ok();

    // La raíz con un nombre que rompe `\input{"..."}` del driver.
    if let Some(c) = e.root_file.chars().find(|c| "#%{}\\\"~^$".contains(*c)) {
        h.push(
            Hallazgo::nuevo("raiz-nombre", Nivel::Error, format!("El nombre de la raíz tiene un «{c}»"), "El driver la carga con `\\input{\"nombre\"}` y ese carácter lo rompe.")
                .con_arreglo("Renombrar el archivo raíz sin # % { } \\ \" ~ ^ $.")
                .en(e.root_file, 1),
        );
    }

    // Variables declaradas con un `\def` incondicional: el driver las define ANTES de cargar la raíz y el `\def` del proyecto las pisa.
    let mut con_def = 0;
    for nombre in e.config.variables.keys() {
        for rel in e.ix.reachable.iter().filter(|r| r.to_ascii_lowercase().ends_with(".tex")) {
            let Some(b) = leer(rel) else { continue };
            for linea in defs_sin_guardia(&String::from_utf8_lossy(&b), nombre) {
                con_def += 1;
                h.push(
                    Hallazgo::nuevo(
                        "variable-def",
                        Nivel::Aviso,
                        format!("«\\{nombre}» se define sin guardia: el menú de compilación no la puede cambiar"),
                        format!("La variable está en latexviewer.json y la app la define antes de cargar la raíz, pero {rel}:{linea} la vuelve a definir sin condición y gana siempre."),
                    )
                    .con_arreglo(format!("Poner el valor por omisión con guardia: \\ifdefined\\{nombre}\\else\\def\\{nombre}{{...}}\\fi"))
                    .en(rel, linea),
                );
            }
        }
    }
    if con_def == 0 && !e.config.variables.is_empty() {
        h.push(Hallazgo::nuevo("variable-def", Nivel::Ok, "Las variables del proyecto tienen su valor por omisión con guardia", ""));
    }

    // Partes que entran por `\input`: `\includeonly` no las toma, así que un perfil de partes elegidas igual compila todo.
    for cmd in e.config.parts.commands.iter().filter(|c| !matches!(c.as_str(), "include" | "input")) {
        // Entre todas las definiciones del proyecto: si alguna carga por `\include` (el libro tiene una por `\input` para la cocción y
        // otra por `\include`), `\includeonly` sirve.
        let (mut por_input, mut con_include) = (None, false);
        for rel in e.ix.reachable.iter().filter(|r| r.to_ascii_lowercase().ends_with(".tex") || r.to_ascii_lowercase().ends_with(".sty")) {
            let Some(b) = leer(rel) else { continue };
            let (i, inc) = definiciones_de_parte(&String::from_utf8_lossy(&b), cmd);
            con_include |= inc;
            if por_input.is_none() {
                por_input = i.map(|l| (rel.clone(), l));
            }
        }
        if let (Some((rel, linea)), false) = (por_input, con_include) {
            h.push(
                Hallazgo::nuevo(
                    "parte-por-input",
                    Nivel::Aviso,
                    format!("«\\{cmd}» carga cada parte con \\input y no con \\include"),
                    format!("`\\includeonly` sólo vale para `\\include`: un perfil de partes elegidas igual compila el documento entero, y sus `.aux` se pisan entre perfiles. La definición está en {rel}:{linea}."),
                )
                .con_arreglo(format!("Cambiar la definición de \\{cmd} para que cargue el archivo con `\\include` (la app no toca tus archivos)."))
                .en(&rel, linea),
            );
        }
    }

    // BOM en un archivo que entra por `\input`: se cuela como un carácter suelto antes del contenido.
    let mut con_bom = 0;
    let mut entran_por_input: Vec<&str> = Vec::new();
    for aristas in e.ix.files.values() {
        for a in aristas {
            if a.kind == crate::graph::EdgeKind::Input {
                if let Some(t) = &a.target {
                    if t.to_ascii_lowercase().ends_with(".tex") && !entran_por_input.contains(&t.as_str()) {
                        entran_por_input.push(t);
                    }
                }
            }
        }
    }
    for rel in entran_por_input {
        if leer(rel).is_some_and(|b| b.starts_with(&[0xEF, 0xBB, 0xBF])) {
            con_bom += 1;
            h.push(
                Hallazgo::nuevo("bom-input", Nivel::Aviso, format!("{rel} tiene BOM y entra por \\input"), "El BOM se le cuela a pdflatex como un carácter suelto en el punto donde entra el archivo.")
                    .con_arreglo("Guardar el archivo como UTF-8 sin BOM.")
                    .en(rel, 1),
            );
        }
    }
    if con_bom == 0 {
        h.push(Hallazgo::nuevo("bom-input", Nivel::Ok, "Ningún archivo que entra por \\input tiene BOM", ""));
    }

    // Otras herramientas que borran los auxiliares después de cada build (LaTeX Workshop con `autoClean`).
    let mut candidatos: Vec<std::path::PathBuf> = vec![e.root.join(".vscode/settings.json")];
    if let Some(padre) = e.root.parent() {
        candidatos.push(padre.join(".vscode/settings.json"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidatos.push(Path::new(&appdata).join("Code/User/settings.json"));
    }
    let re = Regex::new(r#""latex-workshop\.latex\.autoClean\.run"\s*:\s*"(onBuilt|onFailed)""#).expect("patrón válido");
    for c in candidatos {
        let Ok(t) = std::fs::read_to_string(&c) else { continue };
        if let Some(m) = re.captures(&t) {
            h.push(
                Hallazgo::nuevo(
                    "autoclean",
                    Nivel::Aviso,
                    "LaTeX Workshop borra los auxiliares después de cada build",
                    format!("{} tiene `latex-workshop.latex.autoClean.run: {}`. Si compilás también desde VS Code, borra auxiliares que la app necesita entre builds (la app los guarda aparte, en .lv/build, pero los de la raíz se pierden).", c.display(), &m[1]),
                )
                .con_arreglo("Poner `latex-workshop.latex.autoClean.run` en `never` para este proyecto."),
            );
        }
    }
    h
}

/// Lo que dice el historial de la cocción en paralelo: si tarda más de un segundo por figura, se sugiere (sólo eso) excluir las carpetas
/// del antivirus. En el libro de desarrollo (Ryzen 7 3700X) son 0,65 s por figura.
pub fn chequeo_de_coccion(historial: &[Linea]) -> Option<Hallazgo> {
    let l = historial.iter().find(|l| l.tipo == "bake" && l.cocidas >= 20 && !l.cancelado)?;
    let ms = l.ms.saturating_sub(l.listado_ms);
    let por_figura = ms / u64::from(l.cocidas);
    if por_figura <= 1000 {
        return None;
    }
    Some(
        Hallazgo::nuevo(
            "coccion-lenta",
            Nivel::Info,
            format!("La cocción de figuras tarda {:.1} s por figura", por_figura as f64 / 1000.0),
            format!(
                "La última cocción hizo {} figuras con {} subcompilaciones a la vez en {:.0} s. En una máquina de 8 núcleos suele ser menos de 1 s por figura. Si hay un antivirus, analizar cada PDF y cada auxiliar que escribe pdflatex es lo que más suele frenarla.",
                l.cocidas,
                l.trabajos,
                ms as f64 / 1000.0
            ),
        )
        .con_arreglo("Sólo una sugerencia, la app no toca nada: excluir `figuras-cache/` y `.lv/` del análisis en tiempo real de tu antivirus (en Windows Defender: Configuración, Protección antivirus, Exclusiones)."),
    )
}

pub fn chequeo_de_procesos(huerfanos: &[ProcesoTex], bloqueado_por: Option<u32>) -> Vec<Hallazgo> {
    let mut h = Vec::new();
    if let Some(pid) = bloqueado_por {
        h.push(
            Hallazgo::nuevo("candado", Nivel::Aviso, format!("El proyecto está abierto en otra instancia (PID {pid})"), "Esta instancia no compila ni cocina: dos colas sobre el mismo .lv y el mismo cache se pisarían.")
                .con_arreglo("Cerrar la otra instancia y volver a abrir el proyecto."),
        );
    }
    if !huerfanos.is_empty() {
        let lista = huerfanos.iter().map(|p| format!("{} ({})", p.nombre, p.pid)).collect::<Vec<_>>().join(", ");
        h.push(
            Hallazgo::nuevo("huerfanos", Nivel::Aviso, format!("Hay {} proceso{} de TeX de este proyecto que quedó{} de antes", huerfanos.len(), if huerfanos.len() == 1 { "" } else { "s" }, if huerfanos.len() == 1 { "" } else { "n" }), format!("{lista}. Retienen el PDF y los auxiliares y el próximo build puede fallar o colgarse."))
                .con_arreglo("Matarlos desde el aviso que la app muestra al abrir el proyecto (o desde el Administrador de tareas)."),
        );
    }
    h
}

/// El orden del informe: lo grave primero, y dentro de cada nivel el orden en que se generaron.
pub fn ordenar(h: &mut [Hallazgo]) {
    h.sort_by_key(|x| std::cmp::Reverse(x.nivel));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn salida(texto: &str) -> Salida {
        Salida { lanzado: true, codigo: Some(0), texto: texto.into(), colgado: false }
    }

    /// Una sonda con las salidas de una máquina con MiKTeX, que se puede estropear por partes.
    fn sonda_miktex(roto: Option<&'static str>, sin: Option<&'static str>) -> impl Fn(&str, &[&str], Option<&Path>) -> Salida + Sync {
        move |nombre: &str, args: &[&str], _| {
            if sin == Some(nombre) {
                return Salida::default();
            }
            if roto == Some(nombre) {
                return Salida { lanzado: true, codigo: Some(DLL_NO_ENCONTRADA), texto: String::new(), colgado: false };
            }
            match nombre {
                "pdflatex" if args.contains(&"--version") && args.iter().any(|a| a.starts_with("-max-print-line")) => salida("pdfTeX 3.14 (MiKTeX 26.5)"),
                "pdflatex" if args.contains(&"--version") => salida("pdfTeX 3.141592653-2.6-1.40.29 (MiKTeX 26.5)\nkpathsea version 6.4.1"),
                "pdflatex" => salida("LVFMT:2026-06-01\nLVSE:1\n"),
                "latexmk" if args.contains(&"-e") => salida("LVPATH=C:\\MiKTeX\\bin\nLatexmk, John Collins\n"),
                "latexmk" => salida("Latexmk, John Collins, 9 March 2026. Version 4.88\n"),
                "perl" => salida("This is perl 5, version 36, subversion 0 (v5.36.0) built for MSWin32-x64\n"),
                "biber" | "bibtex" => salida("biber version 2.22\n"),
                "makeindex" | "synctex" => salida("usage...\n"),
                _ => Salida::default(),
            }
        }
    }

    fn ver(h: &[Hallazgo], id: &str) -> Vec<Hallazgo> {
        h.iter().filter(|x| x.id == id).cloned().collect()
    }

    const NECESIDADES: Necesidades<'static> = Necesidades { engine: "pdflatex", externaliza: true, usa_biber: true, usa_bibtex: false, usa_makeindex: true, latexmkrc: true };

    #[test]
    fn una_maquina_sana_no_tiene_errores_y_el_path_corto_de_latexmk_se_avisa() {
        let (h, distro) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, None));
        assert_eq!(distro.as_deref(), Some("MiKTeX 26.5"));
        assert!(h.iter().all(|x| x.nivel != Nivel::Error), "{h:#?}");
        assert_eq!(ver(&h, "nucleo")[0].nivel, Nivel::Ok);
        assert_eq!(ver(&h, "shell-escape")[0].nivel, Nivel::Ok);
        let p = &ver(&h, "path-latexmk")[0];
        assert_eq!(p.nivel, Nivel::Aviso, "una sola entrada: el bin de MiKTeX");
        assert!(p.detalle.contains("no puede") || p.detalle.contains("falla en silencio"), "{}", p.detalle);
        assert!(p.arreglo.as_deref().is_some_and(|a| a.contains("ruta completa")));
        // Sin `latexmkrc` en el proyecto no le afecta a nadie: es sólo informativo.
        let (h, _) = chequeos_de_herramientas(&Necesidades { latexmkrc: false, ..NECESIDADES }, &sonda_miktex(None, None));
        let p = &ver(&h, "path-latexmk")[0];
        assert_eq!(p.nivel, Nivel::Info);
        assert!(p.detalle.contains("no tiene `latexmkrc`"), "{}", p.detalle);
        // Si la prueba no imprime nada (otro latexmk) se dice, no se calla.
        let mudo = |nombre: &str, args: &[&str], _: Option<&Path>| -> Salida {
            if nombre == "latexmk" && args.contains(&"-e") { salida("Latexmk, John Collins\n") } else { sonda_miktex(None, None)(nombre, args, None) }
        };
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &mudo);
        assert!(ver(&h, "path-latexmk")[0].titulo.contains("No se pudo leer"));
    }

    #[test]
    fn un_lanzador_roto_con_0xc0000135_es_un_error_que_dice_que_hacer() {
        for programa in ["pdflatex", "latexmk", "synctex"] {
            let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(Some(programa), None));
            let roto: Vec<&Hallazgo> = h.iter().filter(|x| x.titulo.contains("0xC0000135")).collect();
            assert_eq!(roto.len(), 1, "{programa}: {h:#?}");
            assert!(roto[0].detalle.contains("falta una DLL") && roto[0].arreglo.as_deref().is_some_and(|a| a.contains("MiKTeX")));
            assert_eq!(roto[0].nivel, Nivel::Error);
        }
    }

    #[test]
    fn faltan_cosas_y_cada_una_se_dice_segun_la_necesite_el_proyecto() {
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, Some("perl")));
        assert_eq!(ver(&h, "perl")[0].nivel, Nivel::Error, "latexmk lo necesita");
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, Some("bibtex")));
        assert_eq!(ver(&h, "bibtex")[0].nivel, Nivel::Info, "este proyecto no usa bibtex");
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, Some("biber")));
        assert_eq!(ver(&h, "biber")[0].nivel, Nivel::Error, "este proyecto usa biber");
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, Some("synctex")));
        assert_eq!(ver(&h, "synctex")[0].nivel, Nivel::Info, "el CLI no hace falta");
        let (h, distro) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, Some("pdflatex")));
        assert_eq!((h.len(), h[0].id.as_str(), h[0].nivel, distro), (1, "motor", Nivel::Error, None), "sin motor no se sigue");
    }

    #[test]
    fn un_nucleo_viejo_y_un_shell_escape_bloqueado_son_errores() {
        let viejo = |nombre: &str, args: &[&str], _: Option<&Path>| -> Salida {
            if nombre == "pdflatex" && !args.contains(&"--version") {
                salida("LVFMT:2020-02-02\nLVSE:0\n")
            } else {
                sonda_miktex(None, None)(nombre, args, None)
            }
        };
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &viejo);
        let n = &ver(&h, "nucleo")[0];
        assert_eq!(n.nivel, Nivel::Error);
        assert!(n.titulo.contains("2020-02-02") && n.detalle.contains("AddToHook"), "{n:?}");
        assert_eq!(ver(&h, "shell-escape")[0].nivel, Nivel::Error);
        // Sin externalización el shell escape no hace falta y no se mira.
        let (h, _) = chequeos_de_herramientas(&Necesidades { externaliza: false, ..NECESIDADES }, &viejo);
        assert!(ver(&h, "shell-escape").is_empty());
    }

    #[test]
    fn tex_live_sin_max_print_line_es_un_aviso_informativo_y_con_el_flag_no_se_dice_nada() {
        let tl = |nombre: &str, args: &[&str], _: Option<&Path>| -> Salida {
            if nombre == "pdflatex" && args.iter().any(|a| a.starts_with("-max-print-line")) {
                Salida { lanzado: true, codigo: Some(1), texto: "pdflatex: unrecognized option '-max-print-line'".into(), colgado: false }
            } else if nombre == "pdflatex" && args.contains(&"--version") {
                salida("pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023)\n")
            } else {
                sonda_miktex(None, None)(nombre, args, None)
            }
        };
        let (h, distro) = chequeos_de_herramientas(&NECESIDADES, &tl);
        assert_eq!(distro.as_deref(), Some("TeX Live 2023"));
        let m = &ver(&h, "max-print-line")[0];
        assert_eq!(m.nivel, Nivel::Info);
        assert!(m.detalle.contains("max_print_line"), "{m:?}");
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &sonda_miktex(None, None));
        assert!(ver(&h, "max-print-line").is_empty());
    }

    #[test]
    fn el_path_de_latexmk_con_varias_entradas_esta_bien() {
        let largo = |nombre: &str, args: &[&str], _: Option<&Path>| -> Salida {
            if nombre == "latexmk" && args.contains(&"-e") {
                salida("LVPATH=C:\\MiKTeX\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\n")
            } else {
                sonda_miktex(None, None)(nombre, args, None)
            }
        };
        let (h, _) = chequeos_de_herramientas(&NECESIDADES, &largo);
        assert_eq!(ver(&h, "path-latexmk")[0].nivel, Nivel::Ok);
    }

    #[test]
    fn un_def_incondicional_de_una_variable_se_encuentra_y_con_guardia_no() {
        let sin = "% el pie\n\\def\\OpcionPie{completo}\n\\InputIfFileExists{opciones}{}{}\n";
        assert_eq!(defs_sin_guardia(sin, "OpcionPie"), [2]);
        assert!(defs_sin_guardia("\\ifdefined\\OpcionPie\\else\\def\\OpcionPie{completo}\\fi\n", "OpcionPie").is_empty(), "la guardia en la misma línea");
        assert!(defs_sin_guardia("\\ifdefined\\OpcionPie\\else\n  \\def\\OpcionPie{completo}\n\\fi\n", "OpcionPie").is_empty(), "la guardia en la línea de arriba");
        assert!(defs_sin_guardia("\\ifx\\OpcionPie\\undefined\n\\gdef\\OpcionPie{x}\\fi\n", "OpcionPie").is_empty());
        assert!(defs_sin_guardia("% \\def\\OpcionPie{x}\n", "OpcionPie").is_empty(), "comentado");
        assert!(defs_sin_guardia("\\def\\OpcionPieLarga{x}\n", "OpcionPie").is_empty(), "otro nombre que empieza igual");
        assert_eq!(defs_sin_guardia("a\n\n\n\n\\edef\\OpcionPie{x}\n", "OpcionPie"), [5], "una guardia lejos no cuenta");
    }

    fn proyecto(archivos: &[(&str, &[u8])]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, b) in archivos {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b).unwrap();
        }
        d
    }

    fn config(json: &str) -> ProjectConfig {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn el_doctor_de_proyecto_encuentra_la_variable_sin_guardia_el_bom_y_el_autoclean() {
        let d = proyecto(&[
            ("main.tex", b"\\documentclass{book}\n\\input{structure}\n\\input{conbom}\n\\begin{document}\n\\Capitulo{Cap/uno}\n\\end{document}\n"),
            ("structure.tex", b"\\def\\OpcionPie{completo}\n\\newcommand{\\Capitulo}[1]{\\input{#1}}\n"),
            ("conbom.tex", b"\xEF\xBB\xBFhola\n"),
            ("Cap/uno.tex", b"uno\n"),
            (".vscode/settings.json", br#"{ "latex-workshop.latex.autoClean.run": "onBuilt" }"#),
        ]);
        let cfg = config(r#"{ "root": "main.tex", "parts": { "commands": ["Capitulo"] }, "variables": { "OpcionPie": { "choices": ["completo", "autor"] } }, "profiles": { "parcial": { "parts": "selection" } } }"#);
        let ix = ProjectIndex::build(d.path(), "main.tex", &cfg.parts.commands);
        let h = chequeos_de_proyecto(&EntradaDeProyecto { root: d.path(), root_file: "main.tex", config: &cfg, ix: &ix });
        let v = &ver(&h, "variable-def")[0];
        assert_eq!((v.nivel, v.archivo.as_deref(), v.linea), (Nivel::Aviso, Some("structure.tex"), Some(1)), "{h:#?}");
        assert!(v.titulo.contains("OpcionPie") && v.arreglo.as_deref().is_some_and(|a| a.contains("\\ifdefined\\OpcionPie")));
        assert_eq!(ver(&h, "bom-input")[0].archivo.as_deref(), Some("conbom.tex"));
        assert!(ver(&h, "autoclean")[0].detalle.contains("onBuilt"));
        // `\Capitulo` se define con `\input`: `\includeonly` no sirve para sus partes.
        let p = &ver(&h, "parte-por-input")[0];
        assert_eq!((p.archivo.as_deref(), p.linea), (Some("structure.tex"), Some(2)), "{h:#?}");
    }

    #[test]
    fn una_parte_definida_con_include_no_se_avisa_y_con_input_si_en_cualquier_forma_de_definirla() {
        let con_include = "\\newcommand{\\Capitulo}[1]{\\clearpage\\include{#1}}\n";
        assert_eq!(definiciones_de_parte(con_include, "Capitulo"), (None, true));
        assert_eq!(definiciones_de_parte("\n\\newcommand*{\\Capitulo}[1]{\\input{#1}}\n", "Capitulo"), (Some(2), false));
        assert_eq!(definiciones_de_parte("\\renewcommand\\Capitulo[1]{\\input{#1}}\n", "Capitulo"), (Some(1), false));
        assert_eq!(definiciones_de_parte("\\def\\Capitulo#1{\\input{#1}}\n", "Capitulo"), (Some(1), false));
        assert_eq!(definiciones_de_parte("\\NewDocumentCommand{\\Capitulo}{m}{\\subfile{#1}}\n", "Capitulo"), (Some(1), false));
        assert_eq!(definiciones_de_parte("\\newcommand{\\CapituloLargo}[1]{\\input{#1}}\n", "Capitulo"), (None, false), "otro comando que empieza igual");
        // Como el libro: una definición por `\input` (la cocción) y otra por `\include`: `\includeonly` sirve y no se avisa.
        let libro = "\\ifdefined\\CapitulosPorInput\n    \\newcommand{\\Capitulo}[1]{\\FigCacheReset\\clearpage\\input{#1}\\clearpage}\n\\else\n    \\newcommand{\\Capitulo}[1]{\\FigCacheReset\\include{#1}}\n\\fi\n";
        assert_eq!(definiciones_de_parte(libro, "Capitulo"), (Some(2), true));
        // Una macro que arma una figura con `\includegraphics` no es una parte.
        assert_eq!(definiciones_de_parte("\\newcommand{\\Imagen}[1]{\\includegraphics{#1}}\n", "Imagen"), (None, false));
    }

    #[test]
    fn un_capitulo_con_las_dos_definiciones_como_el_libro_no_da_el_aviso_de_parte_por_input() {
        let d = proyecto(&[
            ("main.tex", b"\\documentclass{book}\n\\input{structure}\n\\begin{document}\n\\Capitulo{Cap/uno}\n\\end{document}\n"),
            ("structure.tex", b"\\ifdefined\\CapitulosPorInput\n\\newcommand{\\Capitulo}[1]{\\input{#1}}\n\\else\n\\newcommand{\\Capitulo}[1]{\\include{#1}}\n\\fi\n"),
            ("Cap/uno.tex", b"uno\n"),
        ]);
        let cfg = config(r#"{ "root": "main.tex", "parts": { "commands": ["Capitulo"] }, "profiles": { "parcial": { "parts": "selection" } } }"#);
        let ix = ProjectIndex::build(d.path(), "main.tex", &cfg.parts.commands);
        let h = chequeos_de_proyecto(&EntradaDeProyecto { root: d.path(), root_file: "main.tex", config: &cfg, ix: &ix });
        assert!(ver(&h, "parte-por-input").is_empty(), "{h:#?}");
    }

    #[test]
    fn un_proyecto_sano_no_tiene_avisos_de_proyecto() {
        let d = proyecto(&[
            ("main.tex", b"\\documentclass{book}\n\\ifdefined\\OpcionPie\\else\\def\\OpcionPie{completo}\\fi\n\\begin{document}\n\\include{Cap/uno}\n\\end{document}\n"),
            ("Cap/uno.tex", b"uno\n"),
        ]);
        let cfg = config(r#"{ "root": "main.tex", "variables": { "OpcionPie": {} }, "profiles": { "completo": {} } }"#);
        let ix = ProjectIndex::build(d.path(), "main.tex", &cfg.parts.commands);
        let h = chequeos_de_proyecto(&EntradaDeProyecto { root: d.path(), root_file: "main.tex", config: &cfg, ix: &ix });
        assert!(h.iter().all(|x| x.nivel == Nivel::Ok), "{h:#?}");
    }

    #[test]
    fn una_raiz_con_un_caracter_que_rompe_el_input_es_un_error() {
        let d = proyecto(&[("a#b.tex", b"x")]);
        let cfg = config(r#"{ "root": "a#b.tex", "profiles": { "completo": {} } }"#);
        let ix = ProjectIndex::build(d.path(), "a#b.tex", &cfg.parts.commands);
        let h = chequeos_de_proyecto(&EntradaDeProyecto { root: d.path(), root_file: "a#b.tex", config: &cfg, ix: &ix });
        assert_eq!(ver(&h, "raiz-nombre")[0].nivel, Nivel::Error);
    }

    #[test]
    fn la_coccion_lenta_sugiere_excluir_las_carpetas_del_antivirus_y_no_dice_que_se_haga_solo() {
        let rapida = Linea { tipo: "bake".into(), ms: 110_000, listado_ms: 8_000, cocidas: 158, trabajos: 16, ok: true, ..Default::default() };
        assert!(chequeo_de_coccion(&[rapida.clone()]).is_none(), "0,65 s por figura es lo normal en esta máquina");
        let lenta = Linea { ms: 400_000, ..rapida.clone() };
        let h = chequeo_de_coccion(&[lenta]).unwrap();
        assert_eq!(h.nivel, Nivel::Info);
        assert!(h.titulo.contains("2,5") || h.titulo.contains("2.5"), "{}", h.titulo);
        let a = h.arreglo.unwrap();
        assert!(a.contains("figuras-cache/") && a.contains(".lv/") && a.contains("la app no toca nada"), "{a}");
        // Pocas figuras, o una cocción cancelada, no cuentan; la más nueva es la que vale.
        assert!(chequeo_de_coccion(&[Linea { cocidas: 5, ms: 400_000, ..rapida.clone() }]).is_none());
        assert!(chequeo_de_coccion(&[Linea { cancelado: true, ms: 400_000, ..rapida.clone() }]).is_none());
        assert!(chequeo_de_coccion(&[rapida, Linea { ms: 900_000, tipo: "bake".into(), cocidas: 100, ..Default::default() }]).is_none(), "la más nueva (primera) es la rápida");
    }

    #[test]
    fn los_huerfanos_y_el_candado_se_informan_y_el_informe_pone_lo_grave_primero() {
        let hu = vec![ProcesoTex { pid: 42, nombre: "pdflatex.exe".into(), cwd: "C:\\p".into(), linea: String::new() }];
        let mut h = chequeo_de_procesos(&hu, Some(7));
        assert_eq!(h.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["candado", "huerfanos"]);
        assert!(h[1].titulo.contains("1 proceso de TeX de este proyecto que quedó") && h[1].detalle.contains("pdflatex.exe (42)"));
        assert!(chequeo_de_procesos(&[], None).is_empty());
        h.push(Hallazgo::nuevo("x", Nivel::Error, "e", ""));
        h.push(Hallazgo::nuevo("y", Nivel::Ok, "o", ""));
        h.push(Hallazgo::nuevo("z", Nivel::Info, "i", ""));
        ordenar(&mut h);
        assert_eq!(h.iter().map(|x| x.nivel).collect::<Vec<_>>(), [Nivel::Error, Nivel::Aviso, Nivel::Aviso, Nivel::Info, Nivel::Ok]);
    }

    #[test]
    fn la_sonda_real_lanza_un_programa_y_distingue_el_que_no_existe() {
        let s = sonda_real("este-programa-no-existe-lv", &[], None);
        assert!(!s.lanzado);
        #[cfg(windows)]
        {
            let s = sonda_real("cmd", &["/c", "echo hola & exit 3"], None);
            assert!(s.lanzado && s.codigo == Some(3) && s.texto.contains("hola"), "{s:?}");
        }
    }
}
