import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Problema } from '../backend';
import { extensionProblemas, lineasMarcadas, setProblemas } from '../editor/problemas';
import { FILTRO_INICIAL, marcasDe, navegables, resumen, siguiente, visibles } from './problemas';

const p = (o: Partial<Problema>): Problema => ({ severity: 'error', kind: 'tex', message: 'm', file: 'a.tex', line: 1, line_end: null, context: '', ...o });

const lista: Problema[] = [
  p({ severity: 'error', message: 'Undefined control sequence.', file: 'cap.tex', line: 2 }),
  p({ severity: 'warning', kind: 'undefined-reference', message: "Reference `x' undefined", file: 'main.tex', line: 11 }),
  p({ severity: 'badbox', kind: 'overfull', message: 'Overfull \\hbox (3pt too wide)', file: 'cap.tex', line: 5, line_end: 7 }),
  p({ severity: 'warning', kind: 'package', message: 'Package biblatex Warning: csquotes', file: null, line: null }),
  p({ severity: 'error', message: 'Too many }', file: 'cap.tex', line: 4 }),
];

describe('filtro de problemas', () => {
  it('por defecto muestra errores y avisos, no las cajas mal llenas', () => {
    expect(visibles(lista, FILTRO_INICIAL).map((x) => x.severity)).toEqual(['error', 'warning', 'warning', 'error']);
    expect(visibles(lista, { ...FILTRO_INICIAL, badboxes: true })).toHaveLength(5);
    expect(visibles(lista, { ...FILTRO_INICIAL, errores: false, avisos: false, badboxes: true }).map((x) => x.kind)).toEqual(['overfull']);
  });

  it('el texto filtra por mensaje, archivo y tipo, sin distinguir mayúsculas', () => {
    expect(visibles(lista, { ...FILTRO_INICIAL, texto: 'CAP.TEX' }).map((x) => x.line)).toEqual([2, 4]);
    expect(visibles(lista, { ...FILTRO_INICIAL, texto: 'undefined-reference' })).toHaveLength(1);
    expect(visibles(lista, { ...FILTRO_INICIAL, texto: '  csquotes ' })).toHaveLength(1);
    expect(visibles(lista, { ...FILTRO_INICIAL, texto: 'nada de esto' })).toHaveLength(0);
  });
});

describe('F8 y Mayús+F8', () => {
  it('recorren los que tienen ubicación y dan la vuelta', () => {
    const v = visibles(lista, FILTRO_INICIAL); // error, warning, warning (sin archivo), error
    expect(navegables(v)).toHaveLength(3);
    expect(siguiente(v, -1, 1)).toBe(0);
    expect(siguiente(v, 0, 1)).toBe(1);
    expect(siguiente(v, 1, 1)).toBe(3); // se salta el que no tiene archivo
    expect(siguiente(v, 3, 1)).toBe(0); // da la vuelta
    expect(siguiente(v, 0, -1)).toBe(3);
    expect(siguiente(v, 3, -1)).toBe(1);
  });

  it('sin nada navegable devuelve -1', () => {
    expect(siguiente([], -1, 1)).toBe(-1);
    expect(siguiente([p({ file: null, line: null })], 0, 1)).toBe(-1);
  });
});

describe('marcas por archivo y resumen', () => {
  it('las marcas de un archivo son las que tienen su ruta y una línea, con el rango', () => {
    const m = marcasDe(lista, 'cap.tex');
    expect(m.map((x) => [x.severity, x.line, x.lineEnd])).toEqual([
      ['error', 2, 2],
      ['badbox', 5, 7],
      ['error', 4, 4],
    ]);
    expect(marcasDe(lista, 'otro.tex')).toEqual([]);
  });

  it('el resumen usa el plural correcto y calla lo que es cero', () => {
    expect(resumen(2, 3, 0)).toBe('2 errores · 3 avisos');
    expect(resumen(1, 1, 0)).toBe('1 error · 1 aviso');
    expect(resumen(0, 0, 0)).toBe('');
    expect(resumen(0, 0, 4)).toBe('4 cajas mal llenas');
  });
});

describe('marcas en el editor (CodeMirror)', () => {
  const doc = 'uno\ndos\ntres\ncuatro\ncinco\n';
  const estado = () => EditorState.create({ doc, extensions: [extensionProblemas()] });

  it('el gutter marca la primera línea de cada problema y una línea con varios lleva el más grave', () => {
    let s = estado();
    s = s.update({
      effects: setProblemas.of([
        { severity: 'warning', line: 2, lineEnd: 2, message: 'a', lint: false },
        { severity: 'error', line: 2, lineEnd: 2, message: 'b', lint: false },
        { severity: 'badbox', line: 4, lineEnd: 5, message: 'c', lint: false },
      ]),
    }).state;
    expect(lineasMarcadas(s)).toEqual([2, 4]);
  });

  it('las marcas se mueven con las ediciones: una línea nueva arriba empuja el marcador', () => {
    let s = estado();
    s = s.update({ effects: setProblemas.of([{ severity: 'error', line: 3, lineEnd: 3, message: 'x', lint: false }]) }).state;
    expect(lineasMarcadas(s)).toEqual([3]);
    s = s.update({ changes: { from: 0, insert: 'nueva\n' } }).state;
    expect(lineasMarcadas(s)).toEqual([4]);
    s = s.update({ effects: setProblemas.of([]) }).state;
    expect(lineasMarcadas(s)).toEqual([]);
  });

  it('una línea fuera del documento (el archivo se acortó) se ajusta al final en lugar de romper', () => {
    const s = estado().update({ effects: setProblemas.of([{ severity: 'error', line: 99, lineEnd: 99, message: 'x', lint: false }]) }).state;
    expect(lineasMarcadas(s)).toEqual([s.doc.lines]);
  });
});
