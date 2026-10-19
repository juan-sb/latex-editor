//! Parser mínimo de `.synctex.gz` (formato "SyncTeX Version:1") y las dos consultas.
//!
//! Formato, tal como sale en el libro (ver docs/spikes/S2.md):
//!   Input:N:ruta                         archivo de entrada N
//!   {n  ...  }n                          hoja (página) n
//!   [tag,line:x,y:w,h,d  ...  ]          vbox          (  ...  )  hbox
//!   v tag,line:x,y:w,h,d                 vbox vacía    h  hbox vacía    r  regla
//!   k tag,line:x,y:w                     kern
//!   g / $ / x  tag,line:x,y              glue / math / punto actual
//!   !N                                   comentario con un tamaño: se ignora
//! Todas las posiciones son sp absolutos desde el borde superior izquierdo de la página (la
//! primera caja del libro tiene x = 4736286 sp = 72,0 bp, o sea la pulgada del margen).
//!
//! Detalle que importa: la caja de un párrafo lleva la línea donde TeX terminó de armarla
//! (`(214,230:...`) y sus hijos llevan la del texto (`x214,229:...`). Por eso el forward busca en
//! las hojas y devuelve la caja que las contiene, y el inverse refina mirando los hijos.

use flate2::read::GzDecoder;
use std::fs::File;
use std::io::Read;
use std::time::Instant;

pub const VBOX: u8 = 1;
pub const HBOX: u8 = 2;
pub const VVOID: u8 = 3;
pub const HVOID: u8 = 4;
pub const KERN: u8 = 5;
pub const GLUE: u8 = 6;
pub const MATH: u8 = 7;
pub const CUR: u8 = 8;
pub const RULE: u8 = 9;

#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub parent: u32,
    pub end: u32, // índice del último nodo adentro (para cajas); el propio índice si no tiene hijos
    pub page: u16,
    pub kind: u8,
    pub tag: u16,
    pub line: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub d: i32,
}

pub struct Synctex {
    pub inputs: Vec<(u16, String)>,
    /// sp -> bp
    pub scale: f64,
    pub nodes: Vec<Node>,
    pub pages: usize,
    fwd: Vec<(u64, u32)>,
    by_page: Vec<Vec<u32>>,
}

#[derive(Default, Debug)]
pub struct LoadStats {
    pub gz_bytes: usize,
    pub raw_bytes: usize,
    pub gunzip_ms: f64,
    pub parse_ms: f64,
    pub index_ms: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub page: u32,
    /// borde izquierdo y borde inferior (baseline + profundidad, como informa el CLI), en bp desde arriba a la izquierda
    pub h: f64,
    pub v: f64,
    pub w: f64,
    pub hh: f64,
    /// punto "x,y" que informa el CLI (sólo se llena al leer su salida)
    pub x: f64,
    pub y: f64,
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

/// "tag,line:x,y[:w[,h,d]]" a partir de `p`. `size`: 0 sin tamaño, 1 sólo w, 3 w,h,d.
fn rec(b: &[u8], mut p: usize, size: u8) -> (u16, u32, i32, i32, i32, i32, i32) {
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
    (tag as u16, line as u32, x, y, w, h, d)
}

pub fn load(path: &str) -> std::io::Result<(Synctex, LoadStats)> {
    let mut st = LoadStats::default();
    let t0 = Instant::now();
    let f = File::open(path)?;
    st.gz_bytes = f.metadata()?.len() as usize;
    let mut data = Vec::with_capacity(st.gz_bytes * 8);
    GzDecoder::new(f).read_to_end(&mut data)?;
    st.raw_bytes = data.len();
    st.gunzip_ms = t0.elapsed().as_secs_f64() * 1e3;

    let t1 = Instant::now();
    let mut inputs = Vec::new();
    let (mut unit, mut mag) = (1.0f64, 1000.0f64);
    let mut nodes: Vec<Node> = Vec::with_capacity(st.raw_bytes / 28);
    let mut stack: Vec<u32> = Vec::new();
    let mut page: u16 = 0;
    let mut pages = 0usize;
    let mut in_content = false;

    let mut start = 0usize;
    while start < data.len() {
        let mut end = start;
        while end < data.len() && data[end] != b'\n' {
            end += 1;
        }
        let line = &data[start..end];
        let next = end + 1;
        if !line.is_empty() {
            // Los "Input:" no están sólo en la cabecera: TeX declara cada archivo la primera vez que lo abre,
            // así que también aparecen en medio del contenido (en el libro, 50 de 254).
            if line.starts_with(b"Input:") {
                let mut p = 6;
                let n = num(line, &mut p) as u16;
                let ruta = String::from_utf8_lossy(&line[p + 1..]).trim_end_matches('\r').to_string();
                inputs.push((n, ruta));
            } else if !in_content {
                if line.starts_with(b"Unit:") {
                    unit = String::from_utf8_lossy(&line[5..]).trim().parse().unwrap_or(1.0);
                } else if line.starts_with(b"Magnification:") {
                    mag = String::from_utf8_lossy(&line[14..]).trim().parse().unwrap_or(1000.0);
                } else if line.starts_with(b"Content:") {
                    in_content = true;
                }
            } else {
                match line[0] {
                    b'{' => {
                        let mut p = 1;
                        page = num(line, &mut p) as u16;
                        pages = pages.max(page as usize);
                    }
                    b'}' | b'!' => {}
                    b'[' | b'(' => {
                        let (tag, ln, x, y, w, h, d) = rec(line, 1, 3);
                        let idx = nodes.len() as u32;
                        nodes.push(Node {
                            parent: stack.last().copied().unwrap_or(u32::MAX),
                            end: idx,
                            page,
                            kind: if line[0] == b'[' { VBOX } else { HBOX },
                            tag,
                            line: ln,
                            x,
                            y,
                            w,
                            h,
                            d,
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
                        let (tag, ln, x, y, w, h, d) = rec(line, 1, size);
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
                            tag,
                            line: ln,
                            x,
                            y,
                            w,
                            h,
                            d,
                        });
                    }
                    b'P' => break, // "Postamble:": el resto son totales
                    _ => {}
                }
            }
        }
        start = next;
    }
    st.parse_ms = t1.elapsed().as_secs_f64() * 1e3;

    let t2 = Instant::now();
    let mut fwd: Vec<(u64, u32)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.line > 0)
        .map(|(i, n)| (((n.tag as u64) << 32) | n.line as u64, i as u32))
        .collect();
    fwd.sort_unstable();
    let mut by_page: Vec<Vec<u32>> = vec![Vec::new(); pages + 1];
    for (i, n) in nodes.iter().enumerate() {
        if n.kind == HBOX || n.kind == HVOID {
            by_page[n.page as usize].push(i as u32);
        }
    }
    st.index_ms = t2.elapsed().as_secs_f64() * 1e3;

    Ok((
        Synctex { inputs, scale: unit * (mag / 1000.0) / 65781.76, nodes, pages, fwd, by_page },
        st,
    ))
}

impl Synctex {
    pub fn tag_de(&self, ruta: &str) -> Option<u16> {
        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
        let q = norm(ruta);
        self.inputs.iter().find(|(_, r)| norm(r) == q).map(|(t, _)| *t)
    }

    fn rect_de(&self, n: &Node) -> Rect {
        let s = self.scale;
        Rect {
            page: n.page as u32,
            h: n.x as f64 * s,
            v: (n.y + n.d) as f64 * s,
            w: n.w as f64 * s,
            hh: (n.h + n.d) as f64 * s,
            x: 0.0,
            y: 0.0,
        }
    }

    /// Código -> PDF. Devuelve la línea realmente usada (la pedida, o la más cercana con cajas) y los rectángulos
    /// de las cajas de línea que contienen nodos de esa línea.
    pub fn forward(&self, tag: u16, line: u32) -> (u32, Vec<Rect>) {
        let key = ((tag as u64) << 32) | line as u64;
        let lo = self.fwd.partition_point(|&(k, _)| k < key);
        let mut usada = None;
        if lo < self.fwd.len() && (self.fwd[lo].0 >> 32) as u16 == tag {
            usada = Some(self.fwd[lo].0 & 0xFFFF_FFFF); // la línea pedida o la siguiente que tenga algo
        } else if lo > 0 && (self.fwd[lo - 1].0 >> 32) as u16 == tag {
            usada = Some(self.fwd[lo - 1].0 & 0xFFFF_FFFF);
        }
        let Some(usada) = usada else { return (0, Vec::new()) };
        let k2 = ((tag as u64) << 32) | usada;
        let a = self.fwd.partition_point(|&(k, _)| k < k2);
        let mut cajas: Vec<u32> = Vec::new();
        for &(k, i) in &self.fwd[a..] {
            if k != k2 {
                break;
            }
            let n = &self.nodes[i as usize];
            // Una caja vacía (la sangría de un párrafo, una figura externalizada) no tiene tamaño propio: el CLI
            // devuelve la caja que la contiene. Las hojas, la línea (hbox) en la que están.
            let caja = match n.kind {
                HBOX | VBOX => Some(i),
                HVOID | VVOID => (n.parent != u32::MAX).then_some(n.parent),
                KERN | GLUE | MATH | CUR | RULE => {
                    let p = n.parent;
                    if p != u32::MAX && self.nodes[p as usize].kind == HBOX { Some(p) } else { None }
                }
                _ => None,
            };
            // Una caja de tamaño cero (lo que rodea a una figura externalizada) no sirve para resaltar nada:
            // se sube hasta la primera que tenga tamaño, que es lo que informa el CLI.
            let caja = caja.map(|mut c| {
                loop {
                    let n = &self.nodes[c as usize];
                    if (n.w != 0 || n.h + n.d != 0) || n.parent == u32::MAX {
                        break c;
                    }
                    c = n.parent;
                }
            });
            if let Some(c) = caja {
                if !cajas.contains(&c) {
                    cajas.push(c);
                }
            }
        }
        (usada as u32, cajas.iter().map(|&c| self.rect_de(&self.nodes[c as usize])).collect())
    }

    /// Descripción de la caja y del hijo que eligió el inverse, para depurar desacuerdos con el CLI.
    pub fn explicar(&self, page: u32, px: f64, py: f64) -> String {
        let Some(lista) = self.by_page.get(page as usize) else { return "sin página".into() };
        let (pxs, pys) = ((px / self.scale) as i64, (py / self.scale) as i64);
        let mut s = String::new();
        for &i in lista {
            let n = &self.nodes[i as usize];
            let (x0, x1) = (n.x as i64, n.x as i64 + n.w as i64);
            let (y0, y1) = (n.y as i64 - n.h as i64, n.y as i64 + n.d as i64);
            if n.w > 0 && n.h + n.d > 0 && pxs >= x0 && pxs <= x1 && pys >= y0 && pys <= y1 {
                let hijos: Vec<String> = ((i + 1)..=n.end)
                    .map(|j| &self.nodes[j as usize])
                    .filter(|c| c.line > 0)
                    .take(6)
                    .map(|c| format!("{}:t{}l{}@{:.0}", c.kind, c.tag, c.line, c.x as f64 * self.scale))
                    .collect();
                s += &format!(
                    "\n          caja#{} tipo{} t{} l{} x{:.0} w{:.0} alto{:.1} área{:.0} hijos[{}]",
                    i, n.kind, n.tag, n.line, n.x as f64 * self.scale, n.w as f64 * self.scale,
                    (n.h + n.d) as f64 * self.scale, (n.w as f64 * self.scale) * ((n.h + n.d) as f64 * self.scale), hijos.join(" ")
                );
            }
        }
        s
    }

    /// PDF -> código. (page, x, y) en bp. Devuelve (tag, línea, la caja elegida estaba bajo el punto).
    pub fn inverse(&self, page: u32, px: f64, py: f64) -> Option<(u16, u32, bool)> {
        let lista = self.by_page.get(page as usize)?;
        let (pxs, pys) = ((px / self.scale) as i64, (py / self.scale) as i64);
        let mut mejor: Option<(u32, i64, bool)> = None; // índice, métrica, adentro
        for &i in lista {
            let n = &self.nodes[i as usize];
            let (x0, x1) = (n.x as i64, n.x as i64 + n.w as i64);
            let (y0, y1) = (n.y as i64 - n.h as i64, n.y as i64 + n.d as i64);
            if n.w <= 0 || n.h + n.d <= 0 {
                continue;
            }
            let adentro = pxs >= x0 && pxs <= x1 && pys >= y0 && pys <= y1;
            // adentro: la caja de menor área; afuera: la más cercana
            let metrica = if adentro {
                (n.w as i64) * ((n.h + n.d) as i64)
            } else {
                let dx = if pxs < x0 { x0 - pxs } else if pxs > x1 { pxs - x1 } else { 0 };
                let dy = if pys < y0 { y0 - pys } else if pys > y1 { pys - y1 } else { 0 };
                dx * dx + dy * dy
            };
            // Orden: primero las cajas que contienen el punto, y entre ellas o entre las demás la de menor métrica.
            if mejor.map_or(true, |m| (!adentro, metrica) < (!m.2, m.1)) {
                mejor = Some((i, metrica, adentro));
            }
        }
        let (i, _, adentro) = mejor?;
        let caja = &self.nodes[i as usize];
        // Refinar: el hijo cuya x queda más cerca del punto es el que dice la línea de código.
        let mut elegido = (caja.tag, caja.line);
        let mut mejor_dx = i64::MAX;
        for j in (i + 1)..=caja.end {
            let c = &self.nodes[j as usize];
            // Los registros "x" (posición actual) no cuentan: el primero de cada línea de texto trae la línea
            // SIGUIENTE (1555 en un párrafo de la 1554) y, por estar pegado al borde, ganaba siempre.
            if matches!(c.kind, KERN | GLUE | MATH | HVOID) && c.line > 0 {
                let dx = (c.x as i64 - pxs).abs();
                if dx < mejor_dx {
                    mejor_dx = dx;
                    elegido = (c.tag, c.line);
                }
            }
        }
        Some((elegido.0, elegido.1, adentro))
    }
}
