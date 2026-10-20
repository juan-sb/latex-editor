// Diff de líneas para mostrar qué cambia en `latexviewer.json` antes de escribirlo (F8b). Función pura: LCS por programación dinámica, que
// alcanza de sobra para un archivo de unas cien líneas.

export type TipoDeLinea = 'igual' | 'agrega' | 'quita';

export interface LineaDeDiff {
  tipo: TipoDeLinea;
  texto: string;
}

const lineas = (t: string): string[] => {
  const l = t.replace(/\r\n/g, '\n').split('\n');
  if (l.length > 0 && l[l.length - 1] === '') l.pop();
  return l;
};

/** `antes` es `null` si el archivo no existe: todo se agrega. */
export function diffDeLineas(antes: string | null, despues: string): LineaDeDiff[] {
  const a = antes === null ? [] : lineas(antes);
  const b = lineas(despues);
  // Tabla del largo de la subsecuencia común más larga de los sufijos.
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const out: LineaDeDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ tipo: 'igual', texto: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || t[i + 1][j] >= t[i][j + 1])) {
      // Ante un empate, lo que sale va antes de lo que entra (como un diff unificado).
      out.push({ tipo: 'quita', texto: a[i++] });
    } else {
      out.push({ tipo: 'agrega', texto: b[j++] });
    }
  }
  return out;
}

export function resumenDeDiff(d: LineaDeDiff[]): { agregadas: number; quitadas: number; iguales: number } {
  return { agregadas: d.filter((x) => x.tipo === 'agrega').length, quitadas: d.filter((x) => x.tipo === 'quita').length, iguales: d.filter((x) => x.tipo === 'igual').length };
}

/** Sólo las líneas que cambian con `contexto` líneas iguales alrededor, y `…` donde se saltea un tramo largo. */
export function diffCompacto(d: LineaDeDiff[], contexto = 2): (LineaDeDiff | { tipo: 'salto'; texto: string })[] {
  const mostrar = new Array<boolean>(d.length).fill(false);
  d.forEach((x, i) => {
    if (x.tipo === 'igual') return;
    for (let k = Math.max(0, i - contexto); k <= Math.min(d.length - 1, i + contexto); k++) mostrar[k] = true;
  });
  const out: (LineaDeDiff | { tipo: 'salto'; texto: string })[] = [];
  let saltadas = 0;
  d.forEach((x, i) => {
    if (mostrar[i]) {
      if (saltadas > 0) out.push({ tipo: 'salto', texto: `… ${saltadas} línea${saltadas === 1 ? '' : 's'} sin cambios` });
      saltadas = 0;
      out.push(x);
    } else {
      saltadas++;
    }
  });
  if (saltadas > 0) out.push({ tipo: 'salto', texto: `… ${saltadas} línea${saltadas === 1 ? '' : 's'} sin cambios` });
  return out;
}
