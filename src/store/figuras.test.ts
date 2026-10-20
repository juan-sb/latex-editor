import { describe, expect, it } from 'vitest';
import type { EstadoFiguras, FiguraInfo } from '../backend';
import { agruparFiguras, megabytes, resumenDeFiguras, textoDeProgreso } from './figuras';

const fig = (nombre: string, archivo: string | null, estado: FiguraInfo['estado'] = 'aldia'): FiguraInfo => ({ nombre, slug: null, archivo, estado, bytes: 1 });

describe('panel Figuras: lógica pura', () => {
  it('agrupa por archivo en orden alfabético, las sin archivo al final, y cuenta los estados', () => {
    const g = agruparFiguras([
      fig('a-0', 'Secciones/Uno.tex'),
      fig('b-0', null, 'falta'),
      fig('a-1', 'Secciones/Uno.tex', 'pendiente'),
      fig('c-0', 'Secciones/Dos.tex', 'fallo'),
      fig('a-2', 'Secciones/Uno.tex', 'falta'),
    ]);
    expect(g.map((x) => x.archivo)).toEqual(['Secciones/Dos.tex', 'Secciones/Uno.tex', null]);
    expect(g[1]).toMatchObject({ aldia: 1, pendientes: 2, fallos: 0 });
    expect(g[0]).toMatchObject({ aldia: 0, pendientes: 0, fallos: 1 });
    expect(g[1].figuras.map((f) => f.nombre)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(agruparFiguras([])).toEqual([]);
  });

  it('el resumen calla lo que es cero y usa el plural correcto', () => {
    const base = { figuras: [fig('a', 'x', 'aldia'), fig('b', 'x', 'aldia'), fig('c', 'x', 'pendiente')], figlist: { fechaMs: 1, total: 3, completa: true, delSelloDeHoy: true, vale: true } } as unknown as EstadoFiguras;
    expect(resumenDeFiguras({ ...base, pendientes: 1, fallidas: 0 })).toBe('2 de 3 al día · 1 pendiente');
    expect(resumenDeFiguras({ ...base, pendientes: 2, fallidas: 1 })).toBe('2 de 3 al día · 2 pendientes · 1 falló');
    expect(resumenDeFiguras({ ...base, pendientes: 0, fallidas: 2 })).toBe('2 de 3 al día · 2 fallaron');
    expect(resumenDeFiguras({ ...base, figlist: null, figuras: [], pendientes: 0, fallidas: 0 })).toBe('');
  });

  it('el progreso dice si todavía lista o cuántas van', () => {
    expect(textoDeProgreso({ fase: 'todo', hechas: 0, total: 0, listando: true })).toBe('Listando las figuras…');
    expect(textoDeProgreso({ fase: 'todo', hechas: 12, total: 158, listando: false })).toBe('Cocinando figuras 12/158');
  });

  it('los megabytes llevan un decimal', () => {
    expect(megabytes(0)).toBe('0.0');
    expect(megabytes(20 * 1048576 + 104858)).toBe('20.1');
  });
});
