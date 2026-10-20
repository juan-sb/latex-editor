// Los dos saltos de SyncTeX una vez que el core contestó: del lado del PDF y del fuente se refina por palabra. Es lo que
// usan el store (el usuario) y el smoke de aceptación (que mide cuántas veces cae en la palabra correcta), así los dos
// recorren exactamente el mismo camino.
import type { SyncForward, SyncInverse } from '../backend';
import type { PdfApi } from '../pdf/api';
import { buscarForward, buscarInverse, buscarRango, palabraEnPunto, type LineaFuente, type Rect } from './buscar';
import { palabraEn, palabrasDeLinea } from './texto';

export interface RefinadoForward {
  /** La palabra (o, si no se encontró, las cajas de la línea). */
  rects: Rect[];
  /** `true` si se llegó a la palabra; `false` si sólo hay las cajas de la línea. */
  palabra: boolean;
  /** El índice de la palabra del cursor entre las de su línea (-1 si la línea no tiene palabras). */
  indice: number;
}

/** Del fuente al PDF: busca la palabra del cursor, con contexto, adentro de las cajas que dio SyncTeX. */
export async function refinarForward(host: PdfApi, res: SyncForward, texto: string, columna: number): Promise<RefinadoForward> {
  const paginas = [...new Set(res.rects.map((r) => r.page))];
  const palabrasPdf = (await Promise.all(paginas.map((p) => host.palabrasDePagina(p)))).flat();
  const fuente = palabrasDeLinea(texto);
  const indice = palabraEn(fuente, columna);
  const encontrada = indice >= 0 ? buscarForward(fuente, indice, palabrasPdf, res.rects) : null;
  return { rects: encontrada?.rects ?? res.rects, palabra: encontrada !== null, indice };
}

/**
 * Del fuente al PDF para un TRAMO de una línea (`desde` y `hasta` son columnas de la línea original; `hasta` exclusivo): lo que se
 * seleccionó en el editor. Resalta las palabras del tramo, un rectángulo por renglón del PDF, y no sólo la palabra donde está el cursor
 * (que con una selección es el extremo, y el rectángulo quedaba corrido respecto de lo seleccionado).
 */
export async function refinarRango(host: PdfApi, res: SyncForward, texto: string, desde: number, hasta: number): Promise<RefinadoForward> {
  const paginas = [...new Set(res.rects.map((r) => r.page))];
  const palabrasPdf = (await Promise.all(paginas.map((p) => host.palabrasDePagina(p)))).flat();
  const fuente = palabrasDeLinea(texto);
  const primera = palabraEn(fuente, desde);
  if (primera < 0) return { rects: res.rects, palabra: false, indice: -1 };
  // La última palabra del tramo: la última que empieza antes de `hasta` (al menos la primera).
  let ultima = primera;
  fuente.forEach((p, k) => {
    if (k > primera && p.inicio < hasta) ultima = k;
  });
  const encontrada = buscarRango(fuente, primera, ultima, palabrasPdf, res.rects);
  return { rects: encontrada?.rects ?? res.rects, palabra: encontrada !== null, indice: primera };
}

export interface FuenteLeible {
  /** Cantidad de líneas. */
  lineas: number;
  /** El texto de la línea `n` (1..lineas), sin salto. */
  texto(n: number): string;
}

export interface RefinadoInverse {
  line: number;
  /** Posiciones en la línea original de la palabra encontrada (si se encontró). */
  inicio?: number;
  fin?: number;
  /** Índice de la palabra encontrada entre las de su línea. */
  indice?: number;
}

/**
 * Del PDF al fuente: la palabra clickeada y sus vecinas se buscan en la línea que dio SyncTeX y ±2. Sin coincidencia queda
 * la línea de SyncTeX.
 */
export async function refinarInverse(host: PdfApi, punto: { page: number; x: number; y: number }, res: SyncInverse, fuente: FuenteLeible): Promise<RefinadoInverse> {
  const objetivo = Math.min(Math.max(1, res.line), fuente.lineas);
  const lineas: LineaFuente[] = [];
  for (let n = Math.max(1, objetivo - 2); n <= Math.min(fuente.lineas, objetivo + 2); n++) lineas.push({ n, texto: fuente.texto(n) });
  const palabras = await host.palabrasDePagina(punto.page);
  const k = palabraEnPunto(palabras, punto.page, punto.x, punto.y);
  const ubic = k >= 0 ? buscarInverse(lineas, objetivo, palabras, k) : null;
  return ubic ? { line: ubic.line, inicio: ubic.inicio, fin: ubic.fin, indice: ubic.indice } : { line: objetivo };
}
