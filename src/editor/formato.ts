// Atajos de formato (10.3 del plan). Con selección envuelve; sin selección inserta y deja el cursor adentro; si ya está
// aplicado, lo saca (toggle); con multicursor, en cada selección; en modo matemático cambia el comando.
//
// Son funciones puras de `EditorState` a una transacción, así que se prueban sin vista. Nunca tocan lo que no se seleccionó.
import { ChangeSet, EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import { enModoMatematico } from './matematica';

export type NombreFormato = 'negrita' | 'cursiva' | 'enfasis' | 'subrayado' | 'mono' | 'matematica-en-linea' | 'matematica-display' | 'entorno' | 'comentar';

/** Comando de texto y de matemática de cada formato (`null`: no existe en ese modo). */
const COMANDOS: Partial<Record<NombreFormato, { texto: string | null; mate: string | null }>> = {
  negrita: { texto: 'textbf', mate: 'mathbf' },
  cursiva: { texto: 'textit', mate: 'mathit' },
  enfasis: { texto: 'emph', mate: null },
  subrayado: { texto: 'underline', mate: 'underline' },
  mono: { texto: 'texttt', mate: 'mathtt' },
};

/** La `}` que cierra la `{` de `abre`, o -1. Ignora las llaves escapadas. */
function cierreDe(doc: string, abre: number): number {
  let prof = 0;
  for (let i = abre; i < doc.length; i++) {
    const c = doc[i];
    if (c === '\\') i++;
    else if (c === '{') prof++;
    else if (c === '}' && --prof === 0) return i;
  }
  return -1;
}

/** Si `doc[desde..hasta]` es exactamente `prefijo ... sufijo` con el sufijo cerrando el prefijo, devuelve el interior. */
function interior(doc: string, desde: number, hasta: number, prefijo: string): { de: number; a: number } | null {
  if (!doc.startsWith(prefijo, desde) || hasta - desde < prefijo.length + 1 || doc[hasta - 1] !== '}') return null;
  return cierreDe(doc, desde + prefijo.length - 1) === hasta - 1 ? { de: desde + prefijo.length, a: hasta - 1 } : null;
}

type Resultado = { changes: ChangeSpec; range: SelectionRange };

/** `\cmd{...}` alrededor de la selección o del cursor. */
function envolverComando(state: EditorState, r: SelectionRange, cmd: string): Resultado {
  const doc = state.doc.toString();
  const abre = `\\${cmd}{`;
  if (!r.empty) {
    // 1. La selección es el comando entero: se lo saca.
    const dentro = interior(doc, r.from, r.to, abre);
    if (dentro) {
      const x = doc.slice(dentro.de, dentro.a);
      return { changes: { from: r.from, to: r.to, insert: x }, range: EditorSelection.range(r.from, r.from + x.length) };
    }
    // 2. La selección es el contenido de un comando que la rodea: se lo saca.
    if (doc.slice(r.from - abre.length, r.from) === abre && doc[r.to] === '}' && cierreDe(doc, r.from - 1) === r.to) {
      return {
        changes: [
          { from: r.from - abre.length, to: r.from },
          { from: r.to, to: r.to + 1 },
        ],
        range: EditorSelection.range(r.from - abre.length, r.to - abre.length),
      };
    }
    // 3. Se envuelve.
    return {
      changes: [
        { from: r.from, insert: abre },
        { from: r.to, insert: '}' },
      ],
      range: EditorSelection.range(r.from + abre.length, r.to + abre.length),
    };
  }
  // Sin selección: si el cursor está adentro de `\cmd{...}` de la misma línea, se lo saca; si no, se inserta y el cursor queda adentro.
  const linea = state.doc.lineAt(r.head);
  const antes = doc.slice(linea.from, r.head);
  let k = antes.lastIndexOf(abre);
  while (k >= 0) {
    const cierre = cierreDe(doc, linea.from + k + abre.length - 1);
    if (cierre >= r.head && cierre <= linea.to) {
      const ini = linea.from + k;
      return {
        changes: [
          { from: ini, to: ini + abre.length },
          { from: cierre, to: cierre + 1 },
        ],
        range: EditorSelection.cursor(r.head - abre.length),
      };
    }
    k = antes.lastIndexOf(abre, k - 1);
  }
  return { changes: { from: r.head, insert: `${abre}}` }, range: EditorSelection.cursor(r.head + abre.length) };
}

/** `$...$`: se saca si ya está (selección con `$` alrededor o cursor adentro de un par en la línea), si no se envuelve. */
function matematicaEnLinea(state: EditorState, r: SelectionRange): Resultado | null {
  const doc = state.doc.toString();
  const mate = enModoMatematico(doc, r.from);
  if (!r.empty) {
    if (doc[r.from] === '$' && doc[r.to - 1] === '$' && r.to - r.from >= 2 && doc[r.from + 1] !== '$') {
      const x = doc.slice(r.from + 1, r.to - 1);
      return { changes: { from: r.from, to: r.to, insert: x }, range: EditorSelection.range(r.from, r.from + x.length) };
    }
    if (doc[r.from - 1] === '$' && doc[r.to] === '$' && doc[r.from - 2] !== '$' && doc[r.to + 1] !== '$') {
      return {
        changes: [
          { from: r.from - 1, to: r.from },
          { from: r.to, to: r.to + 1 },
        ],
        range: EditorSelection.range(r.from - 1, r.to - 1),
      };
    }
    if (mate) return null; // adentro de otra matemática no se anida
    return {
      changes: [
        { from: r.from, insert: '$' },
        { from: r.to, insert: '$' },
      ],
      range: EditorSelection.range(r.from + 1, r.to + 1),
    };
  }
  if (mate) {
    // Cursor adentro de `$...$`: se saca el par de la línea.
    const linea = state.doc.lineAt(r.head);
    const antes = doc.slice(linea.from, r.head);
    const a = antes.lastIndexOf('$');
    const b = doc.indexOf('$', r.head);
    if (a >= 0 && b >= 0 && b <= linea.to && doc[linea.from + a - 1] !== '$' && doc[b + 1] !== '$') {
      return {
        changes: [
          { from: linea.from + a, to: linea.from + a + 1 },
          { from: b, to: b + 1 },
        ],
        range: EditorSelection.cursor(r.head - 1),
      };
    }
    return null;
  }
  return { changes: { from: r.head, insert: '$$' }, range: EditorSelection.cursor(r.head + 1) };
}

/** `\[ ... \]`. */
function matematicaDisplay(state: EditorState, r: SelectionRange): Resultado {
  const doc = state.doc.toString();
  if (!r.empty) {
    const x = doc.slice(r.from, r.to);
    if (x.startsWith('\\[') && x.endsWith('\\]') && x.length >= 4) {
      const dentro = x.slice(2, -2).replace(/^ /, '').replace(/ $/, '');
      return { changes: { from: r.from, to: r.to, insert: dentro }, range: EditorSelection.range(r.from, r.from + dentro.length) };
    }
    if (doc.slice(r.from - 3, r.from) === '\\[ ' && doc.slice(r.to, r.to + 3) === ' \\]') {
      return {
        changes: [
          { from: r.from - 3, to: r.from },
          { from: r.to, to: r.to + 3 },
        ],
        range: EditorSelection.range(r.from - 3, r.to - 3),
      };
    }
    return {
      changes: [
        { from: r.from, insert: '\\[ ' },
        { from: r.to, insert: ' \\]' },
      ],
      range: EditorSelection.range(r.from + 3, r.to + 3),
    };
  }
  return { changes: { from: r.head, insert: '\\[  \\]' }, range: EditorSelection.cursor(r.head + 3) };
}

/** Comenta o descomenta las líneas que tocan las selecciones. */
function comentar(state: EditorState): TransactionSpec {
  const lineas = new Map<number, { from: number; text: string }>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    // Una selección que termina justo al principio de una línea no incluye esa línea.
    const b = state.doc.lineAt(r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to).number;
    for (let n = a; n <= b; n++) lineas.set(n, { from: state.doc.line(n).from, text: state.doc.line(n).text });
  }
  const ordenadas = [...lineas.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]);
  const conTexto = ordenadas.filter((l) => l.text.trim() !== '');
  const todasComentadas = conTexto.length > 0 && conTexto.every((l) => /^\s*%/.test(l.text));
  const changes: ChangeSpec[] = [];
  for (const l of ordenadas) {
    if (todasComentadas) {
      const m = /^(\s*)%( ?)/.exec(l.text);
      if (m) changes.push({ from: l.from + m[1].length, to: l.from + m[1].length + 1 + m[2].length });
    } else if (l.text.trim() !== '') {
      changes.push({ from: l.from, insert: '% ' });
    }
  }
  // La selección crece con lo que se inserta en su borde (por defecto un rango no incluye lo que se agrega justo en su inicio).
  const cs = ChangeSet.of(changes, state.doc.length);
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => EditorSelection.range(cs.mapPos(r.anchor, -1), cs.mapPos(r.head, -1))),
    state.selection.mainIndex,
  );
  return { changes: cs, selection, scrollIntoView: true };
}

/** `\begin{▮}...\end{▮}` con un cursor en cada nombre: lo que se escribe cambia los dos a la vez. */
function entorno(state: EditorState): TransactionSpec {
  const nombre = 'entorno';
  const changes: ChangeSpec[] = [];
  const rangos: SelectionRange[] = [];
  let delta = 0;
  for (const r of state.selection.ranges) {
    const sel = state.sliceDoc(r.from, r.to);
    const abre = `\\begin{${nombre}}\n`;
    const texto = `${abre}${sel}\n\\end{${nombre}}`;
    changes.push({ from: r.from, to: r.to, insert: texto });
    const ini = r.from + delta;
    const posBegin = ini + '\\begin{'.length;
    const posEnd = ini + abre.length + sel.length + 1 + '\\end{'.length;
    rangos.push(EditorSelection.range(posBegin, posBegin + nombre.length), EditorSelection.range(posEnd, posEnd + nombre.length));
    delta += texto.length - (r.to - r.from);
  }
  return { changes, selection: EditorSelection.create(rangos, 0), scrollIntoView: true };
}

/** La transacción que aplica el formato, o `null` si no corresponde (por ejemplo `\emph` en matemática). */
export function aplicarFormato(state: EditorState, formato: NombreFormato): TransactionSpec | null {
  if (formato === 'comentar') return comentar(state);
  if (formato === 'entorno') return entorno(state);
  let hecho = false;
  const t = state.changeByRange((r) => {
    let res: Resultado | null = null;
    if (formato === 'matematica-en-linea') res = matematicaEnLinea(state, r);
    else if (formato === 'matematica-display') res = enModoMatematico(state.doc.toString(), r.from) && r.empty ? null : matematicaDisplay(state, r);
    else {
      const c = COMANDOS[formato];
      const cmd = c ? (enModoMatematico(state.doc.toString(), r.from) ? c.mate : c.texto) : null;
      if (cmd) res = envolverComando(state, r, cmd);
    }
    if (!res) return { range: r };
    hecho = true;
    return res;
  });
  return hecho ? { ...t, scrollIntoView: true } : null;
}
