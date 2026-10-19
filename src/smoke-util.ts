// Ayudas compartidas por los smokes de aceptación (`LV_SMOKE`): esperar condiciones, comparar bytes y elegir dónde
// insertar un marcador en un capítulo. Sólo se carga con el smoke.

export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function esperarHasta(cond: () => boolean, limiteMs: number, que: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > limiteMs) throw new Error(`tiempo agotado esperando: ${que}`);
    await dormir(200);
  }
}

export function iguales(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length !== b.length) return `largo ${a.length} contra ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `primer byte distinto en ${i}`;
  return null;
}

export function bytesEsperados(texto: string, eol: 'lf' | 'crlf' | 'cr', bom: boolean): Uint8Array {
  const sep = eol === 'crlf' ? '\r\n' : eol === 'cr' ? '\r' : '\n';
  const cuerpo = new TextEncoder().encode(sep === '\n' ? texto : texto.replace(/\n/g, sep));
  if (!bom) return cuerpo;
  const out = new Uint8Array(cuerpo.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(cuerpo, 3);
  return out;
}

/**
 * Posición (en el texto normalizado) donde se inserta el marcador: después de la primera palabra de un párrafo plano.
 * Con `n` se elige el n-ésimo párrafo así (0 = el primero), para insertar en lugares distintos sin romper una construcción.
 */
export function puntoDeInsercion(texto: string, n = 0): number {
  let inicio = 0;
  let vistos = 0;
  for (const linea of texto.split('\n')) {
    if (linea.length > 100 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(linea) && !/[\\$%{}]/.test(linea.slice(0, 100))) {
      const espacio = linea.indexOf(' ');
      if (espacio > 0 && vistos++ === n) return inicio + espacio + 1;
    }
    inicio += linea.length + 1;
  }
  throw new Error('no encontré un párrafo de texto plano donde insertar el marcador');
}

