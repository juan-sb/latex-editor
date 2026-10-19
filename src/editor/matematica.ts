// ¿El cursor está en modo matemático? (10.3 del plan: los atajos de formato cambian de comando adentro de la matemática).
// Un barrido del texto hasta la posición, sin parser: `$...$`, `$$...$$`, `\(...\)`, `\[...\]` y los entornos de matemática
// (`equation`, `align`...). Adentro de la matemática, `\text{...}` y compañía vuelven a ser texto.

const ENTORNOS = new Set([
  'equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'math', 'flalign', 'alignat',
]);
const TEXTO_EN_MATEMATICA = new Set(['text', 'mbox', 'textrm', 'textit', 'textbf', 'intertext', 'hbox', 'textsf', 'texttt']);

const base = (e: string) => e.replace(/\*$/, '');

export function enModoMatematico(texto: string, pos: number): boolean {
  const fin = Math.min(pos, texto.length);
  // Cada apertura de matemática se recuerda con lo que la cierra.
  let abierta: '$' | '$$' | '\\)' | '\\]' | string | null = null;
  // Llaves que quedan por cerrar de un `\text{...}` abierto adentro de la matemática.
  let textoHasta: number | null = null;
  let prof = 0;
  let i = 0;
  while (i < fin) {
    const c = texto[i];
    if (c === '%') {
      const nl = texto.indexOf('\n', i);
      if (nl < 0 || nl >= fin) break;
      i = nl + 1;
      continue;
    }
    if (c === '{') {
      prof++;
    } else if (c === '}') {
      prof--;
      if (textoHasta !== null && prof < textoHasta) textoHasta = null;
    } else if (c === '$') {
      if (abierta === null) {
        const doble = texto[i + 1] === '$';
        abierta = doble ? '$$' : '$';
        i += doble ? 2 : 1;
        continue;
      }
      if (abierta === '$$' && texto[i + 1] === '$') {
        abierta = null;
        i += 2;
        continue;
      }
      if (abierta === '$') abierta = null;
    } else if (c === '\\') {
      const sig = texto[i + 1] ?? '';
      if (sig === '(' && abierta === null) {
        abierta = '\\)';
        i += 2;
        continue;
      }
      if (sig === '[' && abierta === null) {
        abierta = '\\]';
        i += 2;
        continue;
      }
      if ((sig === ')' && abierta === '\\)') || (sig === ']' && abierta === '\\]')) {
        abierta = null;
        i += 2;
        continue;
      }
      if (/[A-Za-z]/.test(sig)) {
        let j = i + 1;
        while (j < texto.length && /[A-Za-z]/.test(texto[j])) j++;
        const nombre = texto.slice(i + 1, j);
        if ((nombre === 'begin' || nombre === 'end') && texto[j] === '{') {
          const f = texto.indexOf('}', j);
          if (f > 0 && f < fin) {
            const env = texto.slice(j + 1, f);
            if (ENTORNOS.has(base(env))) {
              if (nombre === 'begin' && abierta === null) abierta = `env:${env}`;
              else if (nombre === 'end' && abierta === `env:${env}`) abierta = null;
            }
            i = f + 1;
            continue;
          }
        } else if (abierta !== null && TEXTO_EN_MATEMATICA.has(nombre) && texto[j] === '{') {
          // El argumento de `\text{...}` es texto: se recuerda a qué profundidad de llaves termina.
          if (textoHasta === null) textoHasta = prof + 1;
        }
        i = j;
        continue;
      }
      i += 2; // `\\`, `\$`, `\%`...
      continue;
    }
    i++;
  }
  return abierta !== null && textoHasta === null;
}
