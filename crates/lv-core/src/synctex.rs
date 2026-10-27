//! Parser propio de `.synctex.gz` (formato "SyncTeX Version:1") y las dos consultas (6.1 del plan, decidido por S2).
//!
//! Formato, tal como sale en el libro (ver `docs/spikes/S2.md`):
//!   Input:N:ruta                         archivo de entrada N
//!   {n  ...  }n                          hoja (página) n
//!   [tag,line:x,y:w,h,d  ...  ]          vbox          (  ...  )  hbox
//!   v tag,line:x,y:w,h,d                 vbox vacía    h  hbox vacía    r  regla
//!   k tag,line:x,y:w                     kern
//!   g / $ / x  tag,line:x,y              glue / math / punto actual
//!   !N                                   comentario con un tamaño: se ignora
//! Las posiciones son sp absolutos desde el borde superior izquierdo de la página; `bp = sp / 65781,76`.
//!
//! Lo que S2 aprendió y se respeta acá:
//! - Los `Input:` no están sólo en la cabecera: TeX declara cada archivo la primera vez que lo abre.
//! - La caja de un párrafo lleva la línea donde TeX terminó de armarla y sus hijos la del texto: el forward busca en las
//!   hojas y devuelve la caja que las contiene; el inverse refina mirando los hijos.
//! - Los registros `x` (posición actual) se ignoran al refinar el inverse: el primero de cada línea de texto trae la línea
//!   siguiente y, por estar pegado al borde izquierdo, ganaba siempre.
//! - Una caja de tamaño cero (la sangría de un párrafo, una figura externalizada) se resuelve a la primera contenedora con tamaño.

use flate2::read::GzDecoder;
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;

const VBOX: u8 = 1;
const HBOX: u8 = 2;
const VVOID: u8 = 3;
const HVOID: u8 = 4;
const KERN: u8 = 5;
const GLUE: u8 = 6;
const MATH: u8 = 7;
const CUR: u8 = 8;
const RULE: u8 = 9;

#[derive(Clone, Copy, Debug)]
struct Node {
    parent: u32,
    /// Índice del último nodo adentro (para cajas); el propio índice si no tiene hijos.
    end: u32,
    page: u16,
    kind: u8,
    tag: u16,
    line: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    d: i32,
}

pub struct Synctex {
    inputs: Vec<(u16, String)>,
    /// sp a bp.
    scale: f64,
    /// Corrimiento del origen, en bp, que se suma a cada coordenada (`X Offset` / `Y Offset` del preámbulo). pdfTeX escribe 0
    /// y ya guarda las coordenadas desde la esquina de la página; XeTeX (salida `xdv`) escribe 4736287 sp (1 in) porque sus
    /// coordenadas son las del DVI, que tiene el origen a una pulgada del borde. Sin sumarlo, con xelatex todo quedaba
    /// corrido 72 bp hacia arriba y a la izquierda: el inverse caía en otra línea y el forward resaltaba en otro lado (TP5).
    off_x: f64,
    off_y: f64,
    nodes: Vec<Node>,
    pages: usize,
    /// (tag << 32 | línea, índice de nodo), ordenado.
    fwd: Vec<(u64, u32)>,
    by_page: Vec<Vec<u32>>,
}

/// Un rectángulo en bp, con el origen en el borde superior izquierdo de la página (`y` es el borde de arriba).
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Rect {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug)]
pub struct Forward {
    /// La línea realmente usada: la pedida, o la más cercana que tenga cajas.
    pub line_used: u32,
    pub rects: Vec<Rect>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inverse {
    pub tag: u16,
    pub line: u32,
    /// El punto estaba dentro de la caja elegida (y no sólo cerca de ella).
    pub inside: bool,
}

fn num(b: &[u8], p: &mut usize) -> i32 {
    let mut neg = false;
    if *p < b.len() && b[*p] == b'-' {
        neg = true;
        *p += 1;
    }
    let mut n: i64 = 0;
    while *p < b.len() && b[*p].is_ascii_digit() {
        n = n * 10 + (b[*p] - b'0') as i64;
        *p += 1;
    }
    (if neg { -n } else { n }) as i32
}

struct Registro {
    tag: u16,
    line: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    d: i32,
}

/// `tag,line:x,y[:w[,h,d]]` a partir de `p`. `size`: 0 sin tamaño, 1 sólo w, 3 w,h,d.
fn rec(b: &[u8], mut p: usize, size: u8) -> Registro {
    let tag = num(b, &mut p);
    p += 1;
    let line = num(b, &mut p);
    p += 1;
    let x = num(b, &mut p);
    p += 1;
    let y = num(b, &mut p);
    let (mut w, mut h, mut d) = (0, 0, 0);
    if size >= 1 {
        p += 1;
        w = num(b, &mut p);
    }
    if size >= 3 {
        p += 1;
        h = num(b, &mut p);
        p += 1;
        d = num(b, &mut p);
    }
    Registro { tag: tag as u16, line: line as u32, x, y, w, h, d }
}

fn norm(s: &str) -> String {
    s.replace('\\', "/").trim_start_matches("//?/").to_lowercase()
}

impl Synctex {
    /// Lee un `.synctex.gz`. Un archivo ausente o que no es gzip es un error de E/S.
    pub fn load(path: &Path) -> std::io::Result<Synctex> {
        let f = File::open(path)?;
        let gz = f.metadata()?.len() as usize;
        let mut data = Vec::with_capacity(gz * 8);
        GzDecoder::new(f).read_to_end(&mut data)?;
        Ok(Self::parse(&data))
    }

    /// Lee un `.synctex` ya descomprimido (para los tests).
    pub fn parse(data: &[u8]) -> Synctex {
        let mut inputs = Vec::new();
        let (mut unit, mut mag) = (1.0f64, 1000.0f64);
        let (mut off_x, mut off_y) = (0.0f64, 0.0f64);
        let mut nodes: Vec<Node> = Vec::with_capacity(data.len() / 28);
        let mut stack: Vec<u32> = Vec::new();
        let mut page: u16 = 0;
        let mut pages = 0usize;
        let mut en_contenido = false;

        for linea in data.split(|&c| c == b'\n') {
            let linea = linea.strip_suffix(b"\r").unwrap_or(linea);
            if linea.is_empty() {
                continue;
            }
            if linea.starts_with(b"Input:") {
                let mut p = 6;
                let n = num(linea, &mut p) as u16;
                let ruta = linea.get(p + 1..).map(|r| String::from_utf8_lossy(r).to_string()).unwrap_or_default();
                inputs.push((n, ruta));
                continue;
            }
            if !en_contenido {
                if let Some(v) = linea.strip_prefix(b"Unit:") {
                    unit = String::from_utf8_lossy(v).trim().parse().unwrap_or(1.0);
                } else if let Some(v) = linea.strip_prefix(b"Magnification:") {
                    mag = String::from_utf8_lossy(v).trim().parse().unwrap_or(1000.0);
                } else if let Some(v) = linea.strip_prefix(b"X Offset:") {
                    off_x = String::from_utf8_lossy(v).trim().parse().unwrap_or(0.0);
                } else if let Some(v) = linea.strip_prefix(b"Y Offset:") {
                    off_y = String::from_utf8_lossy(v).trim().parse().unwrap_or(0.0);
                } else if linea.starts_with(b"Content:") {
                    en_contenido = true;
                }
                continue;
            }
            match linea[0] {
                b'{' => {
                    let mut p = 1;
                    page = num(linea, &mut p) as u16;
                    pages = pages.max(page as usize);
                }
                b'}' | b'!' => {}
                b'[' | b'(' => {
                    let r = rec(linea, 1, 3);
                    let idx = nodes.len() as u32;
                    nodes.push(Node {
                        parent: stack.last().copied().unwrap_or(u32::MAX),
                        end: idx,
                        page,
                        kind: if linea[0] == b'[' { VBOX } else { HBOX },
                        tag: r.tag,
                        line: r.line,
                        x: r.x,
                        y: r.y,
                        w: r.w,
                        h: r.h,
                        d: r.d,
                    });
                    stack.push(idx);
                }
                b']' | b')' => {
                    if let Some(i) = stack.pop() {
                        nodes[i as usize].end = (nodes.len() - 1) as u32;
                    }
                }
                k @ (b'h' | b'v' | b'r' | b'k' | b'g' | b'$' | b'x') => {
                    let size = match k {
                        b'h' | b'v' | b'r' => 3,
                        b'k' => 1,
                        _ => 0,
                    };
                    let r = rec(linea, 1, size);
                    let idx = nodes.len() as u32;
                    nodes.push(Node {
                        parent: stack.last().copied().unwrap_or(u32::MAX),
                        end: idx,
                        page,
                        kind: match k {
                            b'h' => HVOID,
                            b'v' => VVOID,
                            b'r' => RULE,
                            b'k' => KERN,
                            b'g' => GLUE,
                            b'$' => MATH,
                            _ => CUR,
                        },
                        tag: r.tag,
                        line: r.line,
                        x: r.x,
                        y: r.y,
                        w: r.w,
                        h: r.h,
                        d: r.d,
                    });
                }
                b'P' => break, // "Postamble:": el resto son totales
                _ => {}
            }
        }

        let mut fwd: Vec<(u64, u32)> =
            nodes.iter().enumerate().filter(|(_, n)| n.line > 0).map(|(i, n)| (((n.tag as u64) << 32) | n.line as u64, i as u32)).collect();
        fwd.sort_unstable();
        let mut by_page: Vec<Vec<u32>> = vec![Vec::new(); pages + 1];
        for (i, n) in nodes.iter().enumerate() {
            if n.kind == HBOX || n.kind == HVOID {
                by_page[n.page as usize].push(i as u32);
            }
        }
        // El corrimiento va en sp sin magnificar (como en `synctex_parser.c`, que lo escala sólo por `Unit`).
        let (off_x, off_y) = (off_x * unit / 65781.76, off_y * unit / 65781.76);
        Synctex { inputs, scale: unit * (mag / 1000.0) / 65781.76, off_x, off_y, nodes, pages, fwd, by_page }
    }

    pub fn pages(&self) -> usize {
        self.pages
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    // --- rutas -----------------------------------------------------------------------------------------------------------

    /// El número de archivo de una ruta relativa a la raíz (o absoluta). Se compara sin distinguir `\` y `/` ni mayúsculas.
    pub fn tag_of(&self, root: &Path, rel: &str) -> Option<u16> {
        let abs = norm(&format!("{}/{}", root.display(), rel));
        let rel_n = norm(rel);
        let con_punto = format!("./{rel_n}");
        self.inputs.iter().find(|(_, r)| {
            let n = norm(r);
            n == abs || n == rel_n || n == con_punto
        }).map(|(t, _)| *t)
    }

    /// La ruta de un archivo de entrada, relativa a la raíz y con `/`. `None` si es del driver (`.lv/`), del sistema o de
    /// fuera del proyecto.
    pub fn rel_of_tag(&self, root: &Path, tag: u16) -> Option<String> {
        let ruta = self.inputs.iter().find(|(t, _)| *t == tag)?.1.replace('\\', "/");
        let ruta = ruta.trim_start_matches("//?/");
        let raiz = root.display().to_string().replace('\\', "/");
        let raiz = raiz.trim_start_matches("//?/");
        let prefijo = format!("{raiz}/");
        let rel = if ruta.len() > prefijo.len() && ruta.is_char_boundary(prefijo.len()) && ruta[..prefijo.len()].eq_ignore_ascii_case(&prefijo) {
            ruta[prefijo.len()..].to_string()
        } else if ruta.contains(':') || ruta.starts_with('/') {
            return None;
        } else {
            ruta.trim_start_matches("./").to_string()
        };
        (!rel.is_empty() && !rel.starts_with(".lv/") && !rel.split('/').any(|c| c == "..")).then_some(rel)
    }

    // --- consultas ---------------------------------------------------------------------------------------------------------

    fn rect_de(&self, n: &Node) -> Rect {
        let s = self.scale;
        Rect { page: n.page as u32, x: n.x as f64 * s + self.off_x, y: (n.y - n.h) as f64 * s + self.off_y, w: n.w as f64 * s, h: (n.h + n.d) as f64 * s }
    }

    /// Código a PDF: las cajas de línea que contienen nodos de esa línea. Si la línea no tiene nada, la más cercana
    /// hacia abajo (o, si no hay, hacia arriba) que sí tenga. `None` si el archivo no tiene ninguna caja.
    pub fn forward(&self, tag: u16, line: u32) -> Option<Forward> {
        let key = ((tag as u64) << 32) | line as u64;
        let lo = self.fwd.partition_point(|&(k, _)| k < key);
        let usada = if lo < self.fwd.len() && (self.fwd[lo].0 >> 32) as u16 == tag {
            self.fwd[lo].0 & 0xFFFF_FFFF
        } else if lo > 0 && (self.fwd[lo - 1].0 >> 32) as u16 == tag {
            self.fwd[lo - 1].0 & 0xFFFF_FFFF
        } else {
            return None;
        };
        let k2 = ((tag as u64) << 32) | usada;
        let a = self.fwd.partition_point(|&(k, _)| k < k2);
        // (caja, fuerte). Una caja es «débil» si la línea sólo aparece en ella por lo que TeX arma al CERRAR un párrafo: TeX corta el
        // párrafo recién cuando lee la línea siguiente (el `\item` de abajo, un `\end{...}`), así que la caja del último renglón y su
        // relleno final (`\parfillskip`, pegado al borde derecho) llevan el número de ESA línea. Con el TP5: el `\item` de la línea 25
        // marcaba el último renglón del ítem de arriba y el resaltado caía un renglón más arriba (ver el test).
        let mut cajas: Vec<(u32, bool)> = Vec::new();
        for &(k, i) in &self.fwd[a..] {
            if k != k2 {
                break;
            }
            let n = &self.nodes[i as usize];
            let fuerte = matches!(n.kind, KERN | GLUE | MATH | CUR | RULE) && !self.en_borde_derecho(n);
            // Una caja vacía no tiene tamaño propio (la sangría de un párrafo, una figura externalizada): la que la
            // contiene. Las hojas, la línea (hbox) en la que están.
            let caja = match n.kind {
                HBOX | VBOX => Some(i),
                HVOID | VVOID => (n.parent != u32::MAX).then_some(n.parent),
                KERN | GLUE | MATH | CUR | RULE => {
                    let p = n.parent;
                    (p != u32::MAX && self.nodes[p as usize].kind == HBOX).then_some(p)
                }
                _ => None,
            };
            // Una caja sin ancho o sin alto (un puntal, una regla) no sirve para resaltar nada: se sube hasta la primera que tenga los dos.
            let caja = caja.map(|mut c| loop {
                let n = &self.nodes[c as usize];
                if (n.w > 0 && n.h + n.d > 0) || n.parent == u32::MAX {
                    break c;
                }
                c = n.parent;
            });
            if let Some(c) = caja {
                match cajas.iter_mut().find(|(x, _)| *x == c) {
                    Some(e) => e.1 |= fuerte,
                    None => cajas.push((c, fuerte)),
                }
            }
        }
        if cajas.is_empty() {
            return None;
        }
        // Si hay contenido de verdad, las débiles se descartan; si no (una ecuación, una figura), quedan todas, como antes.
        if cajas.iter().any(|c| c.1) {
            cajas.retain(|c| c.1);
            // Y al revés: el último renglón de un párrafo que es una sola palabra no tiene ningún nodo de esta línea (XeTeX no registra las
            // letras, sólo el pegamento entre palabras) y sí el relleno final, con el número de la línea siguiente. Si el renglón que
            // sigue a una caja fuerte no tiene más que eso, es la continuación del mismo párrafo («espuria.» en el TP5).
            let mut extra = Vec::new();
            for &(c, _) in &cajas {
                if let Some(s) = self.solo_cierre_debajo(c) {
                    if !cajas.iter().any(|x| x.0 == s) && !extra.contains(&s) {
                        extra.push(s);
                    }
                }
            }
            cajas.extend(extra.into_iter().map(|s| (s, true)));
        }
        Some(Forward { line_used: usada as u32, rects: cajas.iter().map(|&(c, _)| self.rect_de(&self.nodes[c as usize])).collect() })
    }

    /// Un nodo hoja pegado al borde derecho de la caja de línea que lo contiene: el relleno con el que TeX cierra un párrafo.
    fn en_borde_derecho(&self, n: &Node) -> bool {
        if n.parent == u32::MAX {
            return false;
        }
        let p = &self.nodes[n.parent as usize];
        // 1/4 bp de tolerancia (el redondeo de XeTeX deja el relleno 1 sp antes del borde).
        p.kind == HBOX && p.w > 0 && n.x as i64 >= p.x as i64 + p.w as i64 - (0.25 / self.scale) as i64
    }

    /// La caja de línea que sigue a `c` en la misma caja vertical, si todo lo que tiene registrado es el cierre del párrafo.
    fn solo_cierre_debajo(&self, c: u32) -> Option<u32> {
        let caja = &self.nodes[c as usize];
        let s = caja.end as usize + 1;
        let sig = self.nodes.get(s)?;
        if caja.kind != HBOX || sig.kind != HBOX || sig.parent != caja.parent || sig.page != caja.page || sig.w <= 0 {
            return None;
        }
        let mut hojas = 0;
        for j in (s + 1)..=(sig.end as usize) {
            let h = &self.nodes[j];
            if matches!(h.kind, KERN | GLUE | MATH | CUR | RULE) {
                if h.parent as usize != s || !self.en_borde_derecho(h) {
                    return None;
                }
                hojas += 1;
            } else if matches!(h.kind, HBOX | VBOX) {
                return None;
            }
        }
        (hojas > 0).then_some(s as u32)
    }

    /// PDF a código. `(page, x, y)` en bp desde arriba a la izquierda.
    pub fn inverse(&self, page: u32, px: f64, py: f64) -> Option<Inverse> {
        let lista = self.by_page.get(page as usize)?;
        let (pxs, pys) = (((px - self.off_x) / self.scale) as i64, ((py - self.off_y) / self.scale) as i64);
        let mut mejor: Option<(u32, i64, bool)> = None; // índice, métrica, adentro
        for &i in lista {
            let n = &self.nodes[i as usize];
            if n.w <= 0 || n.h + n.d <= 0 {
                continue;
            }
            let (x0, x1) = (n.x as i64, n.x as i64 + n.w as i64);
            let (y0, y1) = (n.y as i64 - n.h as i64, n.y as i64 + n.d as i64);
            let adentro = pxs >= x0 && pxs <= x1 && pys >= y0 && pys <= y1;
            // Adentro: la caja de menor área. Afuera: la más cercana.
            let metrica = if adentro {
                (n.w as i64) * ((n.h + n.d) as i64)
            } else {
                let dx = if pxs < x0 { x0 - pxs } else if pxs > x1 { pxs - x1 } else { 0 };
                let dy = if pys < y0 { y0 - pys } else if pys > y1 { pys - y1 } else { 0 };
                dx * dx + dy * dy
            };
            // Primero las cajas que contienen el punto; entre ellas, o entre las demás, la de menor métrica.
            if mejor.is_none_or(|m| (!adentro, metrica) < (!m.2, m.1)) {
                mejor = Some((i, metrica, adentro));
            }
        }
        let (i, _, adentro) = mejor?;
        let caja = &self.nodes[i as usize];
        // Refinar: el hijo cuya x queda más cerca del punto es el que dice la línea de código.
        let mut elegido = (caja.tag, caja.line);
        // El cierre del párrafo (pegado al borde derecho) lleva la línea SIGUIENTE (ver `forward`): un clic al final del último renglón
        // caía en el `\item` de abajo. Sólo cuenta si la caja no tiene otra cosa.
        let mut mejor_dx = (true, i64::MAX);
        for j in (i + 1)..=caja.end {
            let c = &self.nodes[j as usize];
            if matches!(c.kind, KERN | GLUE | MATH | HVOID) && c.line > 0 {
                let dx = (self.en_borde_derecho(c), (c.x as i64 - pxs).abs());
                if dx < mejor_dx {
                    mejor_dx = dx;
                    elegido = (c.tag, c.line);
                }
            }
        }
        Some(Inverse { tag: elegido.0, line: elegido.1, inside: adentro })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    /// Una página con un párrafo de dos líneas de texto. La caja del párrafo (`(1,5`) lleva la línea 5 (donde TeX terminó
    /// de armarla) y sus hijos la 3 y la 4, como en el libro.
    fn muestra() -> String {
        [
            "SyncTeX Version:1",
            "Input:1:C:/Proyecto con espacios/main.tex",
            "Input:2:C:/Proyecto con espacios/.lv/drivers/lv-parcial.tex",
            "Output:pdf",
            "Magnification:1000",
            "Unit:1",
            "X Offset:0",
            "Y Offset:0",
            "Content:",
            "!100",
            "{1",
            "[1,1:4736286,4736286:30000000,40000000,0",
            "(1,5:4736286,9000000:30000000,500000,100000",
            "x1,3:4736286,9000000",
            "k1,3:4736286,9000000:100000",
            "k1,3:12000000,9000000:100000",
            "k1,3:25000000,9000000:100000",
            ")",
            "(1,5:4736286,10000000:30000000,500000,100000",
            "x1,4:4736286,10000000",
            "Input:3:C:/Proyecto con espacios/Secciones/Aproximación.tex",
            "k3,4:4736286,10000000:100000",
            "k3,4:20000000,10000000:100000",
            ")",
            "h1,7:4736286,12000000:0,0,0",
            "]",
            "}1",
            "Postamble:",
            "Count:10",
        ]
        .join("\n")
            + "\n"
    }

    fn raiz() -> &'static Path {
        Path::new("C:/Proyecto con espacios")
    }

    #[test]
    fn lee_los_archivos_aunque_aparezcan_en_medio_del_contenido() {
        let s = Synctex::parse(muestra().as_bytes());
        assert_eq!(s.pages(), 1);
        assert_eq!(s.inputs.len(), 3, "el Input:3 está dentro de la página");
        assert_eq!(s.tag_of(raiz(), "main.tex"), Some(1));
        assert_eq!(s.tag_of(raiz(), "Secciones/Aproximación.tex"), Some(3));
        assert_eq!(s.tag_of(raiz(), "secciones\\aproximación.TEX"), Some(3), "sin distinguir barras ni mayúsculas");
        assert_eq!(s.tag_of(raiz(), "no-esta.tex"), None);
    }

    #[test]
    fn las_rutas_del_driver_y_de_afuera_no_se_traducen() {
        let s = Synctex::parse(muestra().as_bytes());
        assert_eq!(s.rel_of_tag(raiz(), 1).as_deref(), Some("main.tex"));
        assert_eq!(s.rel_of_tag(raiz(), 3).as_deref(), Some("Secciones/Aproximación.tex"));
        assert_eq!(s.rel_of_tag(raiz(), 2), None, "el driver es de la app");
        assert_eq!(s.rel_of_tag(Path::new("C:/otro"), 1), None, "fuera del proyecto");
        assert_eq!(s.rel_of_tag(raiz(), 99), None);
    }

    #[test]
    fn el_forward_busca_en_las_hojas_y_devuelve_la_caja_de_linea() {
        let s = Synctex::parse(muestra().as_bytes());
        // La línea 3 sólo está en las hojas de la primera caja de línea; la caja misma dice 5.
        let f = s.forward(1, 3).unwrap();
        assert_eq!((f.line_used, f.rects.len()), (3, 1));
        let r = f.rects[0];
        assert!((r.x - 72.0).abs() < 0.1, "{r:?}");
        assert!((r.w - 456.0).abs() < 0.2);
        assert!((r.y - (9_000_000 - 500_000) as f64 / 65781.76).abs() < 0.01 && (r.h - 600_000.0 / 65781.76).abs() < 0.01);
        // Una línea sin cajas se resuelve a la siguiente que tenga; más allá del final, a la última.
        assert_eq!(s.forward(1, 2).unwrap().line_used, 3);
        assert_eq!(s.forward(1, 99).unwrap().line_used, 7, "la última línea con nodos (la caja vacía de la línea 7)");
        assert!(s.forward(9, 1).is_none());
    }

    #[test]
    fn el_forward_de_una_caja_vacia_sube_hasta_una_con_tamano() {
        let s = Synctex::parse(muestra().as_bytes());
        let f = s.forward(1, 7).unwrap();
        // La `h1,7` mide 0x0: se resuelve a la caja que la contiene (la vbox de la página).
        assert_eq!(f.rects.len(), 1);
        assert!(f.rects[0].w > 400.0 && f.rects[0].h > 500.0, "{:?}", f.rects[0]);
    }

    #[test]
    fn el_inverse_refina_con_los_hijos_e_ignora_los_registros_x() {
        let s = Synctex::parse(muestra().as_bytes());
        let bp = |sp: f64| sp / 65781.76;
        // Primera línea de texto: la caja dice 5, los hijos dicen 3. El `x1,3` pegado al borde no tiene que ganar.
        let i = s.inverse(1, bp(13_000_000.0), bp(9_000_000.0)).unwrap();
        assert_eq!((i.tag, i.line, i.inside), (1, 3, true));
        // Segunda línea de texto, y el archivo cambia (tag 3).
        let i = s.inverse(1, bp(19_000_000.0), bp(10_000_000.0)).unwrap();
        assert_eq!((i.tag, i.line), (3, 4));
        // Un punto fuera de todas las cajas se resuelve a la más cercana.
        let i = s.inverse(1, bp(13_000_000.0), bp(9_000_000.0) - 200.0).unwrap();
        assert_eq!(i.line, 3);
        assert!(s.inverse(7, 0.0, 0.0).is_none(), "página inexistente");
    }

    /// Tres renglones como los del TP5 (XeTeX): el ítem h (línea 24) termina en un renglón que TeX cerró al leer la línea 25, y el ítem i
    /// (línea 25) ocupa dos renglones, el segundo con una sola palabra que no deja ningún nodo de la línea 25.
    fn muestra_parrafos() -> String {
        [
            "SyncTeX Version:1",
            "Input:1:C:/P/ej2.tex",
            "Output:xdv",
            "Magnification:1000",
            "Unit:1",
            "X Offset:0",
            "Y Offset:0",
            "Content:",
            "{1",
            "[1,1:0,0:30000000,50000000,0",
            // Renglón del ítem h: contenido de la 24 y el cierre (borde derecho, x = 30692631) con el número de la 25.
            "(1,25:787120,43437292:29905511,538214,179404",
            "g1,24:4489316,43437292",
            "g1,24:5829828,43437292",
            "k1,25:30692631,43437292:2010228",
            "g1,25:30692631,43437292",
            ")",
            // Primer renglón del ítem i: el contenido de la 25 (la caja lleva la 26).
            "(1,26:787120,44774227:29905511,538214,179404",
            "k1,25:4532073,44774227:317605",
            "k1,25:9411440,44774227:276141",
            "k1,25:30692631,44774227:0",
            ")",
            // «espuria.»: sólo el cierre, con el número de la 26.
            "(1,26:787120,45665517:29905511,471476,139217",
            "k1,26:30692630,45665517:27606976",
            "g1,26:30692630,45665517",
            ")",
            "]",
            "}1",
        ]
        .join("\n")
            + "\n"
    }

    #[test]
    fn el_cierre_de_un_parrafo_no_cuenta_y_el_renglon_de_una_palabra_si() {
        let s = Synctex::parse(muestra_parrafos().as_bytes());
        let y = |sp: i32| (sp - 538214) as f64 / 65781.76;
        let f = s.forward(1, 25).unwrap();
        let tops: Vec<f64> = f.rects.iter().map(|r| r.y).collect();
        assert_eq!(f.rects.len(), 2, "{tops:?}");
        assert!((tops[0] - y(44774227)).abs() < 0.01, "el primer renglón del ítem i, no el último del h: {tops:?}");
        assert!((tops[1] - (45665517 - 471476) as f64 / 65781.76).abs() < 0.01, "y el renglón de «espuria.»: {tops:?}");
        // La 24 sigue en su renglón, y la 26 (sólo cierres) se queda con lo que tiene: no hay contenido para descartar nada.
        let f = s.forward(1, 24).unwrap();
        assert_eq!(f.rects.len(), 1);
        assert!((f.rects[0].y - y(43437292)).abs() < 0.01);
        assert!(!s.forward(1, 26).unwrap().rects.is_empty());
    }

    #[test]
    fn un_clic_al_final_del_ultimo_renglon_no_salta_al_item_de_abajo() {
        let s = Synctex::parse(muestra_parrafos().as_bytes());
        let bp = |sp: f64| sp / 65781.76;
        // Al final del renglón del ítem h, más cerca del cierre (línea 25) que del último pegamento de la 24.
        let i = s.inverse(1, bp(29_000_000.0), bp(43_300_000.0)).unwrap();
        assert_eq!(i.line, 24);
    }

    #[test]
    fn el_corrimiento_de_xetex_se_suma_en_las_dos_consultas() {
        // XeTeX (salida xdv) escribe las coordenadas del DVI y un corrimiento de 1 in: las cajas tienen que caer 72 bp más abajo
        // y a la derecha que con el mismo contenido y corrimiento 0, y el inverse tiene que esperar el punto ahí.
        let sin = Synctex::parse(muestra().as_bytes());
        let xe = muestra().replace("Output:pdf", "Output:xdv").replace("X Offset:0", "X Offset:4736287").replace("Y Offset:0", "Y Offset:4736287");
        let con = Synctex::parse(xe.as_bytes());
        let (a, b) = (sin.forward(1, 3).unwrap().rects[0], con.forward(1, 3).unwrap().rects[0]);
        assert!((b.x - a.x - 72.0).abs() < 0.01 && (b.y - a.y - 72.0).abs() < 0.01, "{a:?} {b:?}");
        assert!((b.w - a.w).abs() < 1e-9 && (b.h - a.h).abs() < 1e-9);
        let bp = |sp: f64| sp / 65781.76;
        let i = con.inverse(1, bp(19_000_000.0) + 72.0, bp(10_000_000.0) + 72.0).unwrap();
        assert_eq!((i.tag, i.line, i.inside), (3, 4, true));
        // Sin sumarlo, ese mismo punto (sin el corrimiento) caía en la línea de arriba.
        let i = con.inverse(1, bp(19_000_000.0), bp(10_000_000.0) - 72.0).unwrap();
        assert!(!i.inside);
    }

    #[test]
    fn carga_un_gz_de_verdad_y_rechaza_lo_que_no_lo_es() {
        let d = tempfile::tempdir().unwrap();
        let ruta = d.path().join("x.synctex.gz");
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(muestra().as_bytes()).unwrap();
        std::fs::write(&ruta, e.finish().unwrap()).unwrap();
        let s = Synctex::load(&ruta).unwrap();
        assert_eq!((s.pages(), s.node_count() > 5), (1, true));
        std::fs::write(d.path().join("no.synctex.gz"), b"esto no es gzip").unwrap();
        assert!(Synctex::load(&d.path().join("no.synctex.gz")).is_err());
        assert!(Synctex::load(&d.path().join("falta.synctex.gz")).is_err());
    }

    #[test]
    fn un_archivo_vacio_o_cortado_no_hace_panico() {
        for t in ["", "SyncTeX Version:1\n", "Content:\n{1\n[1,1:0,0:1,1,0\n", "Content:\n{1\n(1,1:a,b:c\n"] {
            let s = Synctex::parse(t.as_bytes());
            let _ = s.forward(1, 1);
            let _ = s.inverse(1, 0.0, 0.0);
        }
    }
}
