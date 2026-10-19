// Búsqueda de palabras para SyncTeX (6.2 y 6.3 del plan): pasa de la palabra del fuente a la palabra del PDF y al revés.
// Lógica pura, sin PDF.js ni CodeMirror: recibe palabras con sus rectángulos (en bp, origen arriba a la izquierda, el mismo
// espacio que SyncTeX) y devuelve rectángulos o posiciones, así se puede probar sin abrir nada.
import { clave, palabrasDeLinea, type PalabraFuente } from './texto';

export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Una palabra de la capa de texto del PDF, con su rectángulo. */
export interface PalabraPdf extends Rect {
  texto: string;
  clave: string;
}

const GUION = /[-‐‑­]$/;
const terminaEnGuion = (p: PalabraPdf) => GUION.test(p.texto);

/** Cuántas palabras del PDF, a partir de `k`, forman la palabra `sclave` del fuente: 1, 2 (cortada con guion al final de línea) o 0. */
function consumir(pdf: PalabraPdf[], k: number, sclave: string): number {
  const p = pdf[k];
  if (!p) return 0;
  if (p.clave === sclave) return 1;
  const q = pdf[k + 1];
  if (q && terminaEnGuion(p) && p.clave + q.clave === sclave) return 2;
  return 0;
}

/** Las palabras de lo que se entiende por "dentro" de unas cajas: su centro cae en alguna (con un margen en bp). */
export function dentroDeCajas(pdf: PalabraPdf[], cajas: Rect[], margen = 2): PalabraPdf[] {
  return pdf.filter((p) => cajas.some((c) => c.page === p.page && p.x + p.w / 2 >= c.x - margen && p.x + p.w / 2 <= c.x + c.w + margen && p.y + p.h / 2 >= c.y - margen && p.y + p.h / 2 <= c.y + c.h + margen));
}

/** Distancia de edición hasta 1: tolera una letra de más, de menos o distinta (una ligadura mal copiada, un acento perdido). */
export function casiIgual(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

export interface ResultadoForward {
  /** Los rectángulos de la palabra (dos si el PDF la cortó con un guion al final de línea). */
  rects: Rect[];
  /** Cuántas palabras vecinas coincidieron además de la buscada (confianza). */
  contexto: number;
}

/**
 * Del fuente al PDF. `fuente` son las palabras de la línea, `idx` la elegida, `pdf` las de la(s) página(s) y `cajas` lo que
 * SyncTeX devolvió para esa línea. Se busca la palabra con hasta 3 de contexto hacia adelante y 2 hacia atrás, sólo
 * adentro de las cajas; entre varias coincidencias gana la que tiene más contexto y, a igualdad, la que está en una
 * posición relativa parecida (la palabra 40 de 60 del párrafo está cerca del 66 % de lo que hay en las cajas).
 * `null` si no aparece: el que llama resalta las cajas de la línea, como hace cualquier SyncTeX.
 */
export function buscarForward(fuente: PalabraFuente[], idx: number, pdf: PalabraPdf[], cajas: Rect[]): ResultadoForward | null {
  const objetivo = fuente[idx];
  if (!objetivo) return null;
  const dentro = dentroDeCajas(pdf, cajas);
  if (dentro.length === 0) return null;
  const buscar = (igual: (a: string, b: string) => boolean): ResultadoForward | null => {
    let mejor: { k: number; n: number; score: number; contexto: number } | null = null;
    for (let k = 0; k < dentro.length; k++) {
      let n = consumir(dentro, k, objetivo.clave);
      if (n === 0 && igual(dentro[k].clave, objetivo.clave)) n = 1;
      if (n === 0) continue;
      let contexto = 0;
      let kk = k + n;
      for (let d = 1; d <= 3; d++) {
        const sf = fuente[idx + d];
        const c = sf ? consumir(dentro, kk, sf.clave) : 0;
        if (!c) break;
        contexto++;
        kk += c;
      }
      for (let d = 1; d <= 2; d++) {
        const sf = fuente[idx - d];
        if (!sf || dentro[k - d]?.clave !== sf.clave) break;
        contexto++;
      }
      const relFuente = idx / Math.max(1, fuente.length - 1);
      const relPdf = k / Math.max(1, dentro.length - 1);
      const score = contexto * 10 - Math.abs(relFuente - relPdf) * 10;
      if (!mejor || score > mejor.score) mejor = { k, n, score, contexto };
    }
    return mejor ? { rects: dentro.slice(mejor.k, mejor.k + mejor.n).map(({ page, x, y, w, h }) => ({ page, x, y, w, h })), contexto: mejor.contexto } : null;
  };
  return buscar((a, b) => a === b) ?? buscar(casiIgual);
}

/** La palabra del PDF bajo el punto `(x, y)` de la página, o la más cercana de su misma línea. `-1` si la página no tiene texto. */
export function palabraEnPunto(pdf: PalabraPdf[], page: number, x: number, y: number): number {
  let mejor = -1;
  let dist = Infinity;
  for (const [k, p] of pdf.entries()) {
    if (p.page !== page) continue;
    const dx = x < p.x ? p.x - x : x > p.x + p.w ? x - (p.x + p.w) : 0;
    const dy = y < p.y ? p.y - y : y > p.y + p.h ? y - (p.y + p.h) : 0;
    // Un punto entre dos líneas se queda con la más cercana en vertical; dentro de la línea, con la más cercana en horizontal.
    const d = dy * 4 + dx;
    if (d < dist) {
      dist = d;
      mejor = k;
    }
  }
  return mejor;
}

export interface LineaFuente {
  n: number;
  texto: string;
}

export interface UbicacionEnFuente {
  line: number;
  /** Posiciones en la línea original, de la palabra encontrada. */
  inicio: number;
  fin: number;
  /** Índice de la palabra dentro de las de su línea. */
  indice: number;
  /** Vecinas que coincidieron además de la clickeada (confianza). */
  contexto: number;
}

/**
 * Del PDF al fuente. `pdf` son las palabras de la página, `k` la clickeada, `lineas` el fuente alrededor de la línea que dio
 * SyncTeX (esa y ±2) y `objetivo` esa línea. Gana la ocurrencia de la palabra con más vecinas iguales y, a igualdad, la más
 * cercana a `objetivo`. `null` si la palabra no está en esas líneas: el que llama deja el cursor en `objetivo`.
 */
export function buscarInverse(lineas: LineaFuente[], objetivo: number, pdf: PalabraPdf[], k: number): UbicacionEnFuente | null {
  const clic = pdf[k];
  if (!clic) return null;
  // Si se clickeó una mitad de una palabra cortada con guion, la palabra es la unión de las dos mitades.
  const empieza = k > 0 && terminaEnGuion(pdf[k - 1]) && pdf[k - 1].page === clic.page ? k - 1 : k;
  const largo = empieza === k && terminaEnGuion(clic) && pdf[k + 1] ? 2 : empieza !== k ? 2 : 1;
  const unida = largo === 2 ? clave(pdf[empieza].texto) + clave(pdf[empieza + 1].texto) : clic.clave;
  const claves = new Set([unida, clic.clave]);
  const tokens = lineas.map((l) => ({ n: l.n, palabras: palabrasDeLinea(l.texto) }));
  const buscar = (igual: (a: string) => boolean): UbicacionEnFuente | null => {
    let mejor: (UbicacionEnFuente & { score: number }) | null = null;
    for (const { n, palabras } of tokens) {
      for (const [t, p] of palabras.entries()) {
        if (!igual(p.clave)) continue;
        let contexto = 0;
        for (let d = 1; d <= 2; d++) {
          if (palabras[t - d] && pdf[empieza - d]?.clave === palabras[t - d].clave) contexto++;
          else break;
        }
        for (let d = 1; d <= 2; d++) {
          const sf = palabras[t + d];
          if (sf && consumir(pdf, empieza + largo + d - 1, sf.clave)) contexto++;
          else break;
        }
        const score = contexto * 3 - Math.abs(n - objetivo) * 1.5;
        if (!mejor || score > mejor.score) mejor = { line: n, inicio: p.inicio, fin: p.fin, indice: t, contexto, score };
      }
    }
    return mejor ? { line: mejor.line, inicio: mejor.inicio, fin: mejor.fin, indice: mejor.indice, contexto: mejor.contexto } : null;
  };
  return buscar((c) => claves.has(c)) ?? buscar((c) => [...claves].some((x) => casiIgual(c, x)));
}
