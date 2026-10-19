// Texto plano de una línea de LaTeX, con el mapa de offsets plano -> original (6.2 y 6.3 del plan). Lo usa SyncTeX para
// refinar: del cursor (en el fuente) a la palabra en el PDF, y de la palabra clickeada en el PDF al lugar exacto del fuente.
//
// No es un parser de TeX: saca lo que en el PDF no es texto (comandos, llaves, `~`, matemática, `\ref`, `\label`) y deja
// lo que sí lo es. Cada párrafo del libro es UNA línea fuente de hasta ~500 caracteres, así que alcanza con trabajar línea
// por línea. Lo que se escape es una palabra que no se encuentra: el salto cae en la línea, que es el comportamiento clásico.

/** Comandos cuyos argumentos no se ven como texto en el PDF (o se ven como un número): se saltan enteros. */
const SIN_TEXTO = new Set([
  'label', 'ref', 'eqref', 'cref', 'Cref', 'pageref', 'autoref', 'nameref', 'cite', 'citep', 'citet', 'parencite', 'textcite',
  'index', 'includegraphics', 'input', 'include', 'usepackage', 'documentclass', 'vspace', 'hspace', 'vskip', 'hskip',
  'bibliography', 'bibliographystyle', 'addbibresource', 'FigurasDe', 'url', 'newcommand', 'renewcommand', 'def', 'color',
  'setlength', 'setcounter', 'addtocounter', 'pagestyle', 'thispagestyle', 'begin', 'end', 'linewidth', 'hline',
]);

/** Comandos cuyo argumento es un texto que se compone aparte (al pie de la página, en un epígrafe). */
const BLOQUES = new Set(['footnote', 'footnotetext', 'marginpar', 'caption']);

const ACENTOS: Record<string, string> = { "'": '́', '`': '̀', '"': '̈', '^': '̂', '~': '̃' };

export interface TextoPlano {
  plano: string;
  /** `mapa[i]` es el índice, en la línea original, del carácter `plano[i]`. */
  mapa: number[];
}

export interface PalabraFuente {
  /** La palabra tal como está en el texto plano. */
  texto: string;
  /** Sin acentos, en minúscula y sin signos: con esto se compara contra el PDF. */
  clave: string;
  /** Posición en la línea original: desde `inicio` hasta `fin` (exclusivo). */
  inicio: number;
  fin: number;
}

/** La forma en que se comparan las palabras del fuente y las del PDF: sin acentos, sin ligaduras, sin mayúsculas ni signos. */
export function clave(s: string): string {
  return s
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Salta un argumento `{...}` (con llaves anidadas) que empieza en `i`; devuelve la posición siguiente. */
function saltarLlaves(s: string, i: number): number {
  let prof = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '{') prof++;
    else if (s[j] === '}' && --prof === 0) return j + 1;
  }
  return s.length;
}

export function aTextoPlano(linea: string): TextoPlano {
  let plano = '';
  const mapa: number[] = [];
  const emitir = (c: string, desde: number) => {
    for (const ch of c) {
      plano += ch;
      mapa.push(desde);
    }
  };
  let i = 0;
  while (i < linea.length) {
    const c = linea[i];
    if (c === '%') break; // comentario hasta el final de la línea
    if (c === '$') {
      // Matemática en línea: se la reemplaza por un espacio (en el PDF son símbolos sueltos, no palabras del fuente).
      const doble = linea[i + 1] === '$';
      const cierre = linea.indexOf(doble ? '$$' : '$', i + (doble ? 2 : 1));
      emitir(' ', i);
      i = cierre < 0 ? linea.length : cierre + (doble ? 2 : 1);
      continue;
    }
    if (c === '~') {
      emitir(' ', i);
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      i++;
      continue;
    }
    if (c !== '\\') {
      emitir(c, i);
      i++;
      continue;
    }
    // Un comando.
    const inicio = i;
    const sig = linea[i + 1] ?? '';
    if (sig === '(' || sig === '[') {
      const cierre = linea.indexOf(sig === '(' ? '\\)' : '\\]', i + 2);
      emitir(' ', inicio);
      i = cierre < 0 ? linea.length : cierre + 2;
      continue;
    }
    if (/[A-Za-z]/.test(sig)) {
      let j = i + 1;
      while (j < linea.length && /[A-Za-z]/.test(linea[j])) j++;
      const nombre = linea.slice(i + 1, j);
      if (linea[j] === '*') j++;
      if (SIN_TEXTO.has(nombre)) {
        // Se salta el comando con sus argumentos opcionales y obligatorios.
        while (linea[j] === '[') {
          const f = linea.indexOf(']', j);
          j = f < 0 ? linea.length : f + 1;
        }
        if (linea[j] === '{') j = saltarLlaves(linea, j);
        emitir(' ', inicio);
        i = j;
        continue;
      }
      if (BLOQUES.has(nombre) && linea[j] === '{') {
        // Una nota al pie o un epígrafe: su texto sale en otro lugar de la página, así que no se pega a la palabra de al lado.
        const fin = saltarLlaves(linea, j);
        const interno = aTextoPlano(linea.slice(j + 1, fin - 1));
        emitir(' ', inicio);
        interno.plano.split('').forEach((ch, n) => {
          plano += ch;
          mapa.push(interno.mapa[n] + j + 1);
        });
        emitir(' ', fin - 1);
        i = fin;
        continue;
      }
      // Los demás comandos (`\textbf`, `\emph`...) se van y su argumento queda como texto. El espacio que sigue a un
      // comando sin argumento no es un espacio del texto.
      if (linea[j] === ' ' && nombre !== 'item') j++;
      if (nombre === 'item') emitir(' ', inicio);
      i = j;
      continue;
    }
    // Un símbolo: `\%`, `\&`, `\\`, `\ `, un acento.
    if ('%$&#_{}'.includes(sig)) {
      emitir(sig, inicio);
      i += 2;
    } else if (sig in ACENTOS) {
      // `\'a`, `\'{a}`, `\'\i`: la letra con su acento combinante, compuesta después.
      let j = i + 2;
      let letra = '';
      if (linea[j] === '{') {
        const f = linea.indexOf('}', j);
        letra = linea.slice(j + 1, f < 0 ? linea.length : f).replace('\\i', 'i').replace('\\j', 'j');
        j = f < 0 ? linea.length : f + 1;
      } else if (linea.startsWith('\\i', j) && !/[A-Za-z]/.test(linea[j + 2] ?? '')) {
        letra = 'i';
        j += 2;
        if (linea[j] === ' ') j++; // TeX se come el espacio que termina `\i`
      } else {
        letra = linea[j] ?? '';
        j++;
      }
      emitir((letra + ACENTOS[sig]).normalize('NFC'), inicio);
      i = j;
    } else {
      emitir(' ', inicio); // `\\`, `\,`, `\;`, `\ `...
      i += 2;
    }
  }
  return { plano, mapa };
}

/** Las palabras del texto plano: letras y números, con un apóstrofo interno si lo hay. */
export function palabrasDe(tp: TextoPlano): PalabraFuente[] {
  const out: PalabraFuente[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
  for (const m of tp.plano.matchAll(re)) {
    const ini = m.index ?? 0;
    const fin = ini + m[0].length;
    const k = clave(m[0]);
    if (!k) continue;
    out.push({ texto: m[0], clave: k, inicio: tp.mapa[ini], fin: tp.mapa[fin - 1] + 1 });
  }
  return out;
}

/** Atajo: las palabras de una línea de LaTeX con sus posiciones en la línea. */
export const palabrasDeLinea = (linea: string): PalabraFuente[] => palabrasDe(aTextoPlano(linea));

/** Índice de la palabra que contiene la posición `col` de la línea (o la más cercana). `-1` si la línea no tiene palabras. */
export function palabraEn(palabras: PalabraFuente[], col: number): number {
  if (palabras.length === 0) return -1;
  let mejor = 0;
  let dist = Infinity;
  palabras.forEach((p, k) => {
    const d = col < p.inicio ? p.inicio - col : col > p.fin ? col - p.fin : 0;
    if (d < dist) {
      dist = d;
      mejor = k;
    }
  });
  return mejor;
}
