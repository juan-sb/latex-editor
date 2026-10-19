import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { aplicarFormato, type NombreFormato } from './formato';
import { enModoMatematico } from './matematica';

/**
 * Un documento con la selección marcada: `⟦...⟧` es un rango y `|` un cursor. Varias marcas son varios rangos (multicursor).
 */
function armar(marcado: string): EditorState {
  let doc = '';
  const rangos: { a: number; b: number }[] = [];
  let ini = -1;
  for (const c of marcado) {
    if (c === '⟦') ini = doc.length;
    else if (c === '⟧') rangos.push({ a: ini, b: doc.length });
    else if (c === '|') rangos.push({ a: doc.length, b: doc.length });
    else doc += c;
  }
  return EditorState.create({ doc, selection: EditorSelection.create(rangos.map((r) => EditorSelection.range(r.a, r.b))), extensions: [EditorState.allowMultipleSelections.of(true)] });
}

/** El documento resultante con la selección marcada como en `armar`. */
function mostrar(s: EditorState): string {
  const marcas: { pos: number; m: string }[] = [];
  for (const r of s.selection.ranges) {
    if (r.empty) marcas.push({ pos: r.from, m: '|' });
    else marcas.push({ pos: r.from, m: '⟦' }, { pos: r.to, m: '⟧' });
  }
  const orden = [...marcas].sort((x, y) => y.pos - x.pos || (x.m === '⟧' ? 1 : -1));
  let t = s.doc.toString();
  for (const { pos, m } of orden) t = t.slice(0, pos) + m + t.slice(pos);
  return t;
}

function con(marcado: string, f: NombreFormato): string | null {
  const s = armar(marcado);
  const tr = aplicarFormato(s, f);
  return tr ? mostrar(s.update(tr).state) : null;
}

describe('modo matemático', () => {
  const en = (t: string) => enModoMatematico(t.replace('|', ''), t.indexOf('|'));
  it('dentro y fuera de $...$, $$...$$, \\(...\\) y \\[...\\]', () => {
    expect(en('texto $a+|b$ fin')).toBe(true);
    expect(en('texto $a+b$ f|in')).toBe(false);
    expect(en('antes $$ x |$$')).toBe(true);
    expect(en('$$ x $$ des|pués')).toBe(false);
    expect(en('uno \\(x|\\) dos')).toBe(true);
    expect(en('uno \\(x\\) d|os')).toBe(false);
    expect(en('uno \\[ x |\\]')).toBe(true);
    expect(en('uno \\[ x \\] d|os')).toBe(false);
  });

  it('los entornos de matemática, con y sin estrella', () => {
    expect(en('\\begin{equation}\n x = |1\n\\end{equation}')).toBe(true);
    expect(en('\\begin{align*} a &= b \\\\ c |\\end{align*}')).toBe(true);
    expect(en('\\begin{equation}x\\end{equation}\ntexto |')).toBe(false);
    expect(en('\\begin{itemize} \\item |x \\end{itemize}')).toBe(false);
  });

  it('\\text{...} dentro de la matemática vuelve a ser texto, y los comentarios y escapes no cuentan', () => {
    expect(en('$ x \\text{ y |z } w$')).toBe(false);
    expect(en('$ x \\text{ yz } w|$')).toBe(true);
    expect(en('cuesta 5\\$ y m|ás')).toBe(false);
    expect(en('% un $ en un comentario\nmás texto |')).toBe(false);
    expect(en('$ \\mbox{a{b}c} d|$')).toBe(true);
  });
});

describe('negrita, cursiva, subrayado y monoespaciado', () => {
  it('con selección envuelve y deja la selección sobre el texto', () => {
    expect(con('una ⟦palabra⟧ aquí', 'negrita')).toBe('una \\textbf{⟦palabra⟧} aquí');
    expect(con('una ⟦palabra⟧ aquí', 'cursiva')).toBe('una \\textit{⟦palabra⟧} aquí');
    expect(con('una ⟦palabra⟧ aquí', 'subrayado')).toBe('una \\underline{⟦palabra⟧} aquí');
    expect(con('una ⟦palabra⟧ aquí', 'mono')).toBe('una \\texttt{⟦palabra⟧} aquí');
    expect(con('una ⟦palabra⟧ aquí', 'enfasis')).toBe('una \\emph{⟦palabra⟧} aquí');
  });

  it('sin selección inserta el comando y deja el cursor adentro', () => {
    expect(con('una | aquí', 'negrita')).toBe('una \\textbf{|} aquí');
    expect(con('|', 'enfasis')).toBe('\\emph{|}');
  });

  it('toggle: si la selección es el comando entero, lo saca', () => {
    expect(con('una ⟦\\textbf{palabra}⟧ aquí', 'negrita')).toBe('una ⟦palabra⟧ aquí');
  });

  it('toggle: si el comando rodea a la selección, lo saca', () => {
    expect(con('una \\textbf{⟦palabra⟧} aquí', 'negrita')).toBe('una ⟦palabra⟧ aquí');
    // Otro comando no cuenta: se envuelve.
    expect(con('una \\textit{⟦palabra⟧} aquí', 'negrita')).toBe('una \\textit{\\textbf{⟦palabra⟧}} aquí');
  });

  it('toggle: sin selección y con el cursor adentro del comando, lo saca', () => {
    expect(con('una \\textbf{pala|bra} aquí', 'negrita')).toBe('una pala|bra aquí');
    // El cursor afuera, al lado, no cuenta.
    expect(con('una \\textbf{palabra}| aquí', 'negrita')).toBe('una \\textbf{palabra}\\textbf{|} aquí');
  });

  it('toggle con llaves anidadas: el cierre es el que corresponde', () => {
    expect(con('\\textbf{a {b} c|}', 'negrita')).toBe('a {b} c|');
    expect(con('⟦\\textbf{a {b} c}⟧ y {d}', 'negrita')).toBe('⟦a {b} c⟧ y {d}');
    // Una selección que NO es el comando entero (el `}` es de otra llave) se envuelve.
    expect(con('⟦\\textbf{a} y {b}⟧', 'negrita')).toBe('\\textbf{⟦\\textbf{a} y {b}⟧}');
  });

  it('en modo matemático cambia el comando: \\mathbf, \\mathit, \\mathtt y \\underline', () => {
    expect(con('$a + ⟦b⟧$', 'negrita')).toBe('$a + \\mathbf{⟦b⟧}$');
    expect(con('$a + ⟦b⟧$', 'cursiva')).toBe('$a + \\mathit{⟦b⟧}$');
    expect(con('$a + ⟦b⟧$', 'mono')).toBe('$a + \\mathtt{⟦b⟧}$');
    expect(con('$a + ⟦b⟧$', 'subrayado')).toBe('$a + \\underline{⟦b⟧}$');
    expect(con('\\begin{equation} x = ⟦y⟧ \\end{equation}', 'negrita')).toBe('\\begin{equation} x = \\mathbf{⟦y⟧} \\end{equation}');
    // Y el toggle vale con el comando de matemática.
    expect(con('$a + \\mathbf{⟦b⟧}$', 'negrita')).toBe('$a + ⟦b⟧$');
  });

  it('\\emph no existe en matemática: no hace nada', () => {
    expect(con('$a + ⟦b⟧$', 'enfasis')).toBeNull();
    // Pero en un \\text{} dentro de la matemática vuelve a ser texto.
    expect(con('$a \\text{⟦b⟧}$', 'enfasis')).toBe('$a \\text{\\emph{⟦b⟧}}$');
  });

  it('con multicursor lo aplica en cada selección, cada una con su modo', () => {
    expect(con('⟦uno⟧ y $⟦dos⟧$ y ⟦tres⟧', 'negrita')).toBe('\\textbf{⟦uno⟧} y $\\mathbf{⟦dos⟧}$ y \\textbf{⟦tres⟧}');
    expect(con('a | b | c', 'cursiva')).toBe('a \\textit{|} b \\textit{|} c');
  });

  it('el texto que no se tocó queda byte a byte igual, con acentos y llaves', () => {
    const s = armar('Ñandú {raro} \\% ⟦sí⟧ fin\n');
    const nuevo = s.update(aplicarFormato(s, 'negrita')!).state.doc.toString();
    expect(nuevo).toBe('Ñandú {raro} \\% \\textbf{sí} fin\n');
  });
});

describe('matemática en línea y display', () => {
  it('Ctrl+M: envuelve, inserta el par o saca el par', () => {
    expect(con('si ⟦x+y⟧ es', 'matematica-en-linea')).toBe('si $⟦x+y⟧$ es');
    expect(con('si | es', 'matematica-en-linea')).toBe('si $|$ es');
    expect(con('si ⟦$x+y$⟧ es', 'matematica-en-linea')).toBe('si ⟦x+y⟧ es');
    expect(con('si $⟦x+y⟧$ es', 'matematica-en-linea')).toBe('si ⟦x+y⟧ es');
    expect(con('si $x+|y$ es', 'matematica-en-linea')).toBe('si x+|y es');
  });

  it('adentro de otra matemática no se anida', () => {
    expect(con('\\[ ⟦x⟧ \\]', 'matematica-en-linea')).toBeNull();
    expect(con('$$ x | $$', 'matematica-en-linea')).toBeNull();
  });

  it('Ctrl+Mayús+M: \\[ ... \\] con su toggle', () => {
    expect(con('antes ⟦x=1⟧ después', 'matematica-display')).toBe('antes \\[ ⟦x=1⟧ \\] después');
    expect(con('antes | después', 'matematica-display')).toBe('antes \\[ | \\] después');
    expect(con('antes \\[ ⟦x=1⟧ \\] después', 'matematica-display')).toBe('antes ⟦x=1⟧ después');
    expect(con('antes ⟦\\[ x=1 \\]⟧ después', 'matematica-display')).toBe('antes ⟦x=1⟧ después');
  });
});

describe('envolver en entorno', () => {
  it('pone \\begin y \\end con un cursor en cada nombre', () => {
    const s = armar('antes\n⟦cuerpo⟧\ndespués');
    const t = s.update(aplicarFormato(s, 'entorno')!).state;
    expect(t.doc.toString()).toBe('antes\n\\begin{entorno}\ncuerpo\n\\end{entorno}\ndespués');
    expect(t.selection.ranges).toHaveLength(2);
    const nombres = t.selection.ranges.map((r) => t.sliceDoc(r.from, r.to));
    expect(nombres).toEqual(['entorno', 'entorno']);
    // Escribir en los dos cursores cambia el nombre en los dos lugares a la vez.
    const escrito = t.update(t.changeByRange((r) => ({ changes: { from: r.from, to: r.to, insert: 'center' }, range: EditorSelection.cursor(r.from + 6) })));
    expect(escrito.state.doc.toString()).toBe('antes\n\\begin{center}\ncuerpo\n\\end{center}\ndespués');
  });

  it('con varias selecciones envuelve cada una y deja dos cursores por cada una', () => {
    const s = armar('⟦a⟧ y ⟦b⟧');
    const t = s.update(aplicarFormato(s, 'entorno')!).state;
    expect(t.doc.toString()).toBe('\\begin{entorno}\na\n\\end{entorno} y \\begin{entorno}\nb\n\\end{entorno}');
    expect(t.selection.ranges.map((r) => t.sliceDoc(r.from, r.to))).toEqual(['entorno', 'entorno', 'entorno', 'entorno']);
  });

  it('sin selección inserta un entorno vacío', () => {
    const s = armar('x|y');
    const t = s.update(aplicarFormato(s, 'entorno')!).state;
    expect(t.doc.toString()).toBe('x\\begin{entorno}\n\n\\end{entorno}y');
  });
});

describe('comentar', () => {
  const comentar = (m: string) => con(m, 'comentar');
  it('comenta la línea del cursor y la descomenta', () => {
    expect(comentar('uno\ndo|s\ntres')).toBe('uno\n% do|s\ntres');
    expect(comentar('uno\n% do|s\ntres')).toBe('uno\ndo|s\ntres');
    expect(comentar('uno\n%dos|\ntres')).toBe('uno\ndos|\ntres');
  });

  it('con una selección de varias líneas: todas se comentan, o todas se descomentan', () => {
    expect(comentar('⟦uno\ndos⟧\ntres')).toBe('⟦% uno\n% dos⟧\ntres');
    expect(comentar('⟦% uno\n% dos⟧\ntres')).toBe('⟦uno\ndos⟧\ntres');
    // Si alguna no estaba comentada, se comenta todo (las que ya lo estaban quedan con dos %).
    expect(comentar('⟦uno\n% dos⟧')).toBe('⟦% uno\n% % dos⟧');
  });

  it('respeta la sangría al descomentar y salta las líneas en blanco al comentar', () => {
    expect(comentar('⟦  % uno\n\n  % dos⟧')).toBe('⟦  uno\n\n  dos⟧');
    expect(comentar('⟦uno\n\ndos⟧')).toBe('⟦% uno\n\n% dos⟧');
  });

  it('una selección que termina al principio de una línea no comenta esa línea', () => {
    expect(comentar('⟦uno\n⟧dos')).toBe('⟦% uno\n⟧dos');
  });

  it('con multicursor en líneas distintas comenta cada una', () => {
    expect(comentar('uno|\ndos\ntres|')).toBe('% uno|\ndos\n% tres|');
  });
});
