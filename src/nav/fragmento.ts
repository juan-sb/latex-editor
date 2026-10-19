// Qué fragmento compilar para la vista previa (8.2 del plan): la selección si hay, y si no el entorno que rodea al cursor, o, fuera de
// todo entorno, el párrafo. Lógica pura sobre el texto: no toca el editor ni el disco.

export interface Fragmento {
  texto: string;
  /** Desde dónde y hasta dónde del documento (offsets), para mostrar de dónde salió. */
  desde: number;
  hasta: number;
  /** Qué se eligió: la selección, un entorno (con su nombre) o el párrafo. */
  tipo: 'seleccion' | 'entorno' | 'parrafo';
  nombre?: string;
}

interface Entorno {
  nombre: string;
  desde: number;
  hasta: number;
  /** El entorno que lo contiene, si hay. */
  padre: Entorno | null;
}

/** Los comentarios se reemplazan por espacios (mismos offsets) para que un `% \begin{figure}` no cuente. */
function sinComentarios(texto: string): string {
  return texto
    .split('\n')
    .map((l) => {
      let barras = 0;
      for (let i = 0; i < l.length; i++) {
        if (l[i] === '\\') {
          barras++;
          continue;
        }
        if (l[i] === '%' && barras % 2 === 0) return l.slice(0, i) + ' '.repeat(l.length - i);
        barras = 0;
      }
      return l;
    })
    .join('\n');
}

/** Todos los entornos balanceados del texto, con su rango y su padre. Un `\begin` sin su `\end` (o al revés) se ignora. */
export function entornos(texto: string): Entorno[] {
  const limpio = sinComentarios(texto);
  const re = /\\(begin|end)\s*\{([^{}]+)\}/g;
  const pila: Entorno[] = [];
  const hechos: Entorno[] = [];
  for (let m = re.exec(limpio); m; m = re.exec(limpio)) {
    const nombre = m[2];
    if (m[1] === 'begin') {
      pila.push({ nombre, desde: m.index, hasta: -1, padre: pila[pila.length - 1] ?? null });
    } else {
      // Se cierra el último abierto con ese nombre; lo que quedó abierto adentro se descarta (está mal balanceado).
      let i = pila.length - 1;
      while (i >= 0 && pila[i].nombre !== nombre) i--;
      if (i < 0) continue;
      const e = pila[i];
      pila.length = i;
      e.hasta = m.index + m[0].length;
      hechos.push(e);
    }
  }
  return hechos;
}

/** Los entornos "de dibujo" cuyo fragmento con sentido es el `figure` que los trae (con su `\caption`, su número y su `\label`). */
const DENTRO_DE_FLOTANTE = new Set(['tikzpicture', 'axis', 'subfigure', 'center', 'centering', 'minipage', 'scope']);
const FLOTANTES = new Set(['figure', 'figure*', 'table', 'table*']);

/** Los límites del párrafo que contiene `pos` (líneas en blanco). */
function parrafo(texto: string, pos: number): { desde: number; hasta: number } {
  let desde = pos;
  while (desde > 0 && !/\n[ \t]*\n$/.test(texto.slice(Math.max(0, desde - 80), desde).replace(/\r/g, ''))) desde--;
  let hasta = pos;
  while (hasta < texto.length && !/^\n[ \t]*\n/.test(texto.slice(hasta, hasta + 80).replace(/\r/g, ''))) hasta++;
  return { desde, hasta };
}

/**
 * El fragmento para `[desde, hasta]` (la selección del editor; con `desde === hasta` es sólo el cursor). Con selección, el texto
 * elegido tal cual. Sin selección, el entorno más interno que rodea al cursor, salvo que sea un dibujo dentro de un `figure` o un
 * `table`: ahí el flotante entero. Fuera de todo entorno, el párrafo. `null` si no hay nada que compilar.
 */
export function fragmentoDelCursor(texto: string, desde: number, hasta: number): Fragmento | null {
  const a = Math.min(desde, hasta);
  const b = Math.max(desde, hasta);
  if (b > a) {
    const t = texto.slice(a, b);
    return t.trim() ? { texto: t, desde: a, hasta: b, tipo: 'seleccion' } : null;
  }
  // `document` rodea a todo: no es "el entorno actual" de nadie.
  const rodean = entornos(texto).filter((e) => e.nombre !== 'document' && e.desde <= a && a <= e.hasta);
  // El más interno es el de menor rango.
  let e = rodean.sort((x, y) => x.hasta - x.desde - (y.hasta - y.desde))[0];
  if (e && DENTRO_DE_FLOTANTE.has(e.nombre)) {
    for (let p = e.padre; p; p = p.padre) {
      if (FLOTANTES.has(p.nombre)) {
        e = p;
        break;
      }
      if (!DENTRO_DE_FLOTANTE.has(p.nombre)) break;
    }
  }
  if (e) return { texto: texto.slice(e.desde, e.hasta), desde: e.desde, hasta: e.hasta, tipo: 'entorno', nombre: e.nombre };
  const p = parrafo(texto, a);
  const t = texto.slice(p.desde, p.hasta);
  return t.trim() ? { texto: t.trim(), desde: p.desde, hasta: p.hasta, tipo: 'parrafo' } : null;
}
