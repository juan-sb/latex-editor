import { describe, expect, it } from 'vitest';
import type { Simbolos } from '../backend';
import { describir, resolverDefinicion, resolverUsos, tokenEnCursor } from './definiciones';

const t = (linea: string) => tokenEnCursor(linea.replace('|', ''), linea.indexOf('|'));

describe('qué hay bajo el cursor', () => {
  it('el argumento de un \\ref, con cualquier variante y con la clave exacta', () => {
    expect(t('ver \\ref{sec:|uno} y más')).toMatchObject({ tipo: 'ref', nombre: 'sec:uno', comando: 'ref' });
    expect(t('ver \\eqref{eq:a|}')).toMatchObject({ tipo: 'ref', nombre: 'eq:a', comando: 'eqref' });
    expect(t('ver \\cref{a,b|,c}')).toMatchObject({ tipo: 'ref', nombre: 'b' });
    expect(t('ver \\cref{a, |b ,c}')).toMatchObject({ tipo: 'ref', nombre: 'b' });
    expect(t('ver \\autoref*{|x}')).toMatchObject({ tipo: 'ref', nombre: 'x' });
  });

  it('citas, etiquetas, archivos, imágenes, bibliografías y entornos', () => {
    expect(t('\\cite[p.~3]{k1, k|2}')).toMatchObject({ tipo: 'cite', nombre: 'k2' });
    expect(t('\\parencite{cla|ve}')).toMatchObject({ tipo: 'cite', nombre: 'clave' });
    expect(t('\\label{sec:|uno}')).toMatchObject({ tipo: 'label', nombre: 'sec:uno' });
    expect(t('\\input{Secciones/ca|p}')).toMatchObject({ tipo: 'input', nombre: 'Secciones/cap' });
    expect(t('\\include{Capítulos/In|tro}')).toMatchObject({ tipo: 'input', nombre: 'Capítulos/Intro' });
    expect(t('\\includegraphics[width=3cm]{img/fo|to}')).toMatchObject({ tipo: 'graphics', nombre: 'img/foto' });
    expect(t('\\addbibresource{re|fs.bib}')).toMatchObject({ tipo: 'bib', nombre: 'refs.bib' });
    expect(t('\\begin{al|ign*}')).toMatchObject({ tipo: 'entorno', nombre: 'align*' });
  });

  it('un comando sin argumento, con el cursor adentro o al final del nombre', () => {
    expect(t('el \\Capitulo|{x}')).toMatchObject({ tipo: 'comando', nombre: 'Capitulo' });
    expect(t('el \\RR| de')).toMatchObject({ tipo: 'comando', nombre: 'RR' });
    expect(t('el \\R|R de')).toMatchObject({ tipo: 'comando', nombre: 'RR' });
  });

  it('el rango del token es el del nombre y no el del comando', () => {
    const tok = t('ver \\ref{sec:|uno}')!;
    expect('ver \\ref{sec:uno}'.slice(tok.inicio, tok.fin)).toBe('sec:uno');
  });

  it('fuera de todo no hay token', () => {
    expect(t('texto | común')).toBeNull();
    expect(t('\\ref{}|')).toBeNull();
    expect(t('')).toBeNull();
  });
});

const simbolos: Simbolos = {
  labels: [{ name: 'sec:uno', file: 'cap.tex', line: 12, context: 'Uno' }],
  refs: [
    { name: 'sec:uno', command: 'ref', file: 'main.tex', line: 5 },
    { name: 'sec:uno', command: 'cref', file: 'cap.tex', line: 40 },
    { name: 'otra', command: 'ref', file: 'main.tex', line: 9 },
  ],
  cites: [{ name: 'k1', command: 'cite', file: 'main.tex', line: 7 }],
  bib: [{ key: 'k1', kind: 'book', file: 'refs.bib', line: 30, author: 'A', title: 'T', year: '2020' }],
  sections: [],
  defs: [
    { name: 'RR', kind: 'command', file: 'structure.tex', line: 3, args: 0 },
    { name: 'caja', kind: 'environment', file: 'structure.tex', line: 8, args: 1 },
    { name: 'sn', kind: 'operator', file: 'structure.tex', line: 5, args: 0 },
  ],
  files: [
    { rel: 'Secciones/Cap.tex', kind: 'tex' },
    { rel: 'refs.bib', kind: 'bib' },
    { rel: 'img/foto.png', kind: 'image' },
  ],
  lint: [],
  scan_ms: 1,
};

const tk = (tipo: Parameters<typeof resolverDefinicion>[0]['tipo'], nombre: string) => ({ tipo, nombre, inicio: 0, fin: nombre.length });

describe('a dónde lleva', () => {
  it('una etiqueta, una clave y un comando definido en el proyecto', () => {
    expect(resolverDefinicion(tk('ref', 'sec:uno'), simbolos)).toEqual({ rel: 'cap.tex', line: 12 });
    expect(resolverDefinicion(tk('cite', 'k1'), simbolos)).toEqual({ rel: 'refs.bib', line: 30 });
    expect(resolverDefinicion(tk('comando', 'RR'), simbolos)).toEqual({ rel: 'structure.tex', line: 3 });
    expect(resolverDefinicion(tk('comando', 'sn'), simbolos)).toEqual({ rel: 'structure.tex', line: 5 });
    expect(resolverDefinicion(tk('entorno', 'caja'), simbolos)).toEqual({ rel: 'structure.tex', line: 8 });
  });

  it('un \\input con o sin extensión y sin distinguir mayúsculas, una .bib y una imagen', () => {
    expect(resolverDefinicion(tk('input', 'Secciones/Cap'), simbolos)).toEqual({ rel: 'Secciones/Cap.tex', line: 1 });
    expect(resolverDefinicion(tk('input', 'secciones/cap.tex'), simbolos)).toEqual({ rel: 'Secciones/Cap.tex', line: 1 });
    expect(resolverDefinicion(tk('bib', 'refs'), simbolos)).toEqual({ rel: 'refs.bib', line: 1 });
    expect(resolverDefinicion(tk('graphics', 'img/foto'), simbolos)).toEqual({ rel: 'img/foto.png', line: 1, imagen: true });
  });

  it('lo que no está definido, o ya es la definición, no lleva a ningún lado', () => {
    expect(resolverDefinicion(tk('ref', 'no-existe'), simbolos)).toBeNull();
    expect(resolverDefinicion(tk('cite', 'fantasma'), simbolos)).toBeNull();
    expect(resolverDefinicion(tk('comando', 'textbf'), simbolos)).toBeNull();
    expect(resolverDefinicion(tk('label', 'sec:uno'), simbolos)).toBeNull();
    expect(resolverDefinicion(tk('input', 'nada'), simbolos)).toBeNull();
  });
});

describe('dónde se usa', () => {
  it('una etiqueta se busca por \\ref y por la propia \\label, una cita por sus usos', () => {
    const usos = resolverUsos(tk('ref', 'sec:uno'), simbolos);
    expect(usos).toEqual([
      { file: 'main.tex', line: 5, comando: 'ref' },
      { file: 'cap.tex', line: 40, comando: 'cref' },
    ]);
    expect(resolverUsos(tk('label', 'sec:uno'), simbolos)).toEqual(usos);
    expect(resolverUsos(tk('cite', 'k1'), simbolos)).toEqual([{ file: 'main.tex', line: 7, comando: 'cite' }]);
    expect(resolverUsos(tk('comando', 'RR'), simbolos)).toEqual([]);
  });

  it('la descripción nombra lo que se busca', () => {
    expect(describir(tk('ref', 'sec:uno'))).toBe('la etiqueta sec:uno');
    expect(describir(tk('comando', 'RR'))).toBe('el comando \\RR');
  });
});
