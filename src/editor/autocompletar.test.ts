import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Simbolos } from '../backend';
import { crearFuente, entornoAbierto, textoDeEntorno } from './autocompletar';

const simbolos: Simbolos = {
  labels: [
    { name: 'sec:uno', file: 'cap.tex', line: 3, context: 'Primera sección' },
    { name: 'eq:butter', file: 'cap.tex', line: 20, context: '|H(j\\omega)|^2 = 1/(1+...)' },
    { name: 'sec:uno', file: 'otro.tex', line: 1, context: 'repetida' },
  ],
  refs: [],
  cites: [],
  bib: [
    { key: 'lathi', kind: 'book', file: 'refs.bib', line: 1, author: 'Lathi, B. P. and Green, R.', title: 'Linear Systems and Signals', year: '2009' },
    { key: 'oppenheim', kind: 'book', file: 'refs.bib', line: 9, author: 'Oppenheim, A.', title: 'Signals and Systems', year: '' },
  ],
  sections: [],
  defs: [
    { name: 'RR', kind: 'command', file: 'structure.tex', line: 3, args: 0 },
    { name: 'sn', kind: 'operator', file: 'structure.tex', line: 5, args: 0 },
    { name: 'caja', kind: 'environment', file: 'structure.tex', line: 8, args: 1 },
    { name: 'teo', kind: 'theorem', file: 'structure.tex', line: 9, args: 0 },
  ],
  files: [
    { rel: 'main.tex', kind: 'tex' },
    { rel: 'Secciones/Uno.tex', kind: 'tex' },
    { rel: 'refs.bib', kind: 'bib' },
    { rel: 'img/foto.png', kind: 'image' },
    { rel: 'img/otra.pdf', kind: 'image' },
  ],
  lint: [],
  scan_ms: 1,
};

/** Ofertas en la posición de `|` del texto (o en el final si no hay). */
function en(texto: string, explicito = false, s: Simbolos | null = simbolos): CompletionResult | null {
  const pos = texto.includes('|') ? texto.indexOf('|') : texto.length;
  const doc = texto.replace('|', '');
  const state = EditorState.create({ doc });
  return crearFuente(() => s)(new CompletionContext(state, pos, explicito));
}

const etiquetas = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

describe('etiquetas tras \\ref{', () => {
  it('ofrece cada etiqueta una vez, con su contexto, para todas las variantes', () => {
    for (const cmd of ['ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref', 'nameref']) {
      expect(etiquetas(en(`texto \\${cmd}{`)), cmd).toEqual(['sec:uno', 'eq:butter']);
    }
    const r = en('\\ref{')!;
    expect(r.options[0].detail).toBe('Primera sección');
    expect(r.options[0].info).toBe('cap.tex:3');
    expect(r.from).toBe('\\ref{'.length);
  });

  it('con varias claves completa sólo la última, y respeta lo que ya se escribió', () => {
    const r = en('\\cref{sec:uno, eq|')!;
    expect(r.from).toBe('\\cref{sec:uno, '.length);
    const r2 = en('\\ref{sec:u|')!;
    expect(r2.from).toBe('\\ref{'.length);
  });

  it('con el argumento ya cerrado no ofrece nada', () => {
    expect(en('\\ref{sec:uno}')).toBeNull();
    expect(en('\\ref{a}b|')).toBeNull();
  });
});

describe('claves tras \\cite{', () => {
  it('ofrece cada clave con autor y año, y el título como información', () => {
    const r = en('\\cite{')!;
    expect(etiquetas(r)).toEqual(['lathi', 'oppenheim']);
    expect(r.options[0].detail).toBe('Lathi, B. P. (2009)');
    expect(r.options[0].info).toBe('Linear Systems and Signals');
    expect(r.options[1].detail).toBe('Oppenheim, A.'); // sin año no queda un paréntesis vacío
  });

  it('todas las variantes y los argumentos opcionales', () => {
    for (const t of ['\\parencite{', '\\textcite{', '\\citep{', '\\autocite*{', '\\cite[p.~3]{', '\\cite[a][b]{']) expect(etiquetas(en(t)), t).toEqual(['lathi', 'oppenheim']);
    expect(etiquetas(en('\\cite{lathi,'))).toEqual(['lathi', 'oppenheim']);
  });

  it('sin símbolos todavía no rompe y no ofrece nada', () => {
    expect(etiquetas(en('\\cite{', false, null))).toEqual([]);
    expect(etiquetas(en('\\ref{', false, null))).toEqual([]);
  });
});

describe('entornos tras \\begin{ y \\end{', () => {
  it('base más los del proyecto (entornos, teoremas)', () => {
    const e = etiquetas(en('\\begin{'));
    expect(e).toContain('itemize');
    expect(e).toContain('equation*');
    expect(e).toContain('caja');
    expect(e).toContain('teo');
    expect(e.filter((x) => x === 'itemize')).toHaveLength(1);
  });

  it('en \\end{ el entorno abierto va primero', () => {
    const r = en('\\begin{itemize}\n\\item uno\n\\begin{enumerate}\n\\item a\n\\end{enumerate}\n\\end{')!;
    const orden = [...r.options].sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
    expect(orden[0].label).toBe('itemize');
    expect(orden[0].boost).toBe(99);
  });

  it('el entorno abierto se calcula con la pila de begin y end', () => {
    expect(entornoAbierto('\\begin{a}\\begin{b}\\end{b}')).toBe('a');
    expect(entornoAbierto('\\begin{a}\\begin{b}')).toBe('b');
    expect(entornoAbierto('\\begin{a}\\end{a}')).toBeNull();
    expect(entornoAbierto('\\begin{a}\\begin{b}\\end{a}')).toBeNull();
    expect(entornoAbierto('')).toBeNull();
  });

  it('al elegir un entorno tras \\begin se inserta con su \\end y el cursor en el renglón de adentro', () => {
    const t = textoDeEntorno('center');
    expect(t.insert).toBe('center}\n  \n\\end{center}');
    expect(t.insert.slice(0, t.cursor)).toBe('center}\n  ');
  });
});

describe('rutas', () => {
  it('\\input e \\include ofrecen los .tex sin extensión; \\includegraphics las imágenes con ella', () => {
    expect(etiquetas(en('\\input{'))).toEqual(['main', 'Secciones/Uno']);
    expect(etiquetas(en('\\include{Sec'))).toEqual(['main', 'Secciones/Uno']);
    expect(etiquetas(en('\\includegraphics[width=3cm]{'))).toEqual(['img/foto.png', 'img/otra.pdf']);
    expect(etiquetas(en('\\addbibresource{'))).toEqual(['refs.bib']);
    expect(etiquetas(en('\\bibliography{'))).toEqual(['refs']);
  });

  it('el desde es el comienzo de lo ya escrito en el argumento', () => {
    expect(en('\\input{Secciones/U|')!.from).toBe('\\input{'.length);
  });
});

describe('comandos', () => {
  it('tras una barra y al menos una letra: los del proyecto primero y los de la base', () => {
    const r = en('el \\R')!;
    expect(r.from).toBe('el \\'.length);
    const l = etiquetas(r);
    expect(l[0]).toBe('RR');
    expect(l.slice(0, 2)).toEqual(['RR', 'sn']);
    expect(l).toContain('Re');
    expect(l).toContain('textbf');
    expect(l.filter((x) => x === 'RR')).toHaveLength(1);
    expect(r.options[0].detail).toBe('proyecto');
  });

  it('una barra sola sólo ofrece si se pidió a propósito (Ctrl+Espacio)', () => {
    expect(en('el \\')).toBeNull();
    expect(en('el \\', true)).not.toBeNull();
  });

  it('no ofrece después de \\\\ ni en medio de una palabra', () => {
    expect(en('línea\\\\te')).toBeNull();
    expect(en('palabra\\')).toBeNull();
    expect(en('sin barra')).toBeNull();
  });
});
