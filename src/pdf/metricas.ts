// Dónde cae cada palabra dentro de un tramo de texto del PDF (lo que PDF.js llama un «item» de la capa de texto). Lógica pura, sin
// PDF.js ni DOM: recibe una función que mide un texto en la fuente del tramo, así se prueba sin abrir nada.
//
// Se probó repartir el ancho del tramo en proporción a la cantidad de caracteres (lo que hacía `palabrasDePagina`) y el resaltado de
// SyncTeX salía corrido: en el libro, 5,7 bp de mediana y hasta 15,4 bp en el borde izquierdo contra las letras que se ven (smoke de
// F4, `docs/benchmarks.md`). Una «i» no ocupa lo que una «m», y las palabras del final de un renglón justificado acumulan el error.
// PDF.js dibuja su capa de texto midiendo el texto con la fuente y estirándolo hasta el ancho del tramo; acá se hace lo mismo para
// que el rectángulo caiga donde cae la letra.

export interface PalabraEnTramo {
  texto: string;
  /** Posición (índice) de la palabra en el texto del tramo. */
  ini: number;
  /** Distancia desde el comienzo del tramo, en las mismas unidades que `ancho`. */
  x: number;
  w: number;
}

/**
 * Las palabras (corridas sin espacios) de un tramo y dónde están, dado el ancho real del tramo.
 * `medir` devuelve el ancho de un texto en la fuente del tramo (en cualquier unidad: se normaliza para que el tramo entero mida `ancho`).
 * Sin `medir`, o si mide 0, se reparte en proporción a los caracteres.
 */
export function palabrasDelTramo(str: string, ancho: number, medir: ((texto: string) => number) | null): PalabraEnTramo[] {
  const total = medir ? medir(str) : 0;
  const usar = medir && total > 0 && Number.isFinite(total) ? medir : null;
  const escala = usar ? ancho / total : ancho / Math.max(1, str.length);
  const hasta = (n: number) => (usar ? usar(str.slice(0, n)) : n) * escala;
  const out: PalabraEnTramo[] = [];
  for (const m of str.matchAll(/\S+/g)) {
    const ini = m.index ?? 0;
    const x = hasta(ini);
    out.push({ texto: m[0], ini, x, w: hasta(ini + m[0].length) - x });
  }
  return out;
}
