import { describe, expect, it } from 'vitest';
import { palabrasDelTramo } from './metricas';

// Una fuente de mentira: la «i» y el espacio miden 1, el resto 2.
const medir = (t: string) => [...t].reduce((n, ch) => n + (ch === 'i' || ch === ' ' ? 1 : 2), 0);

describe('palabras de un tramo del PDF', () => {
  it('con la fuente medida, cada palabra cae donde cae su letra y el tramo entero mide su ancho', () => {
    // «ii mm»: el tramo mide 2 + 1 + 4 = 7 y se estira a 70 (escala 10): la segunda palabra empieza en 30 y mide 40.
    const p = palabrasDelTramo('ii mm', 70, medir);
    expect(p.map((x) => x.texto)).toEqual(['ii', 'mm']);
    expect(p[0]).toMatchObject({ ini: 0, x: 0, w: 20 });
    expect(p[1]).toMatchObject({ ini: 3, x: 30, w: 40 });
    expect(p[1].x + p[1].w).toBeCloseTo(70);
  });

  it('el reparto por cantidad de caracteres NO da esas posiciones (el error que se medía en el libro)', () => {
    const sinMedir = palabrasDelTramo('ii mm', 70, null);
    expect(sinMedir[1].x).toBeCloseTo(42); // 3 de 5 caracteres, y la letra de verdad está en 30
    expect(sinMedir[1].w).toBeCloseTo(28);
  });

  it('sin medida (o con una que da 0) cae al reparto proporcional', () => {
    expect(palabrasDelTramo('ab cd', 50, () => 0)).toEqual(palabrasDelTramo('ab cd', 50, null));
    const [a, b] = palabrasDelTramo('ab cd', 50, null);
    expect([a.x, a.w, b.x, b.w]).toEqual([0, 20, 30, 20]);
  });

  it('un tramo con espacios al principio, al final y repetidos', () => {
    const p = palabrasDelTramo('  ii  mm ', 110, medir);
    expect(p.map((x) => [x.texto, x.ini])).toEqual([
      ['ii', 2],
      ['mm', 6],
    ]);
    expect(p[0].x).toBeCloseTo(20); // dos espacios de 1 sobre un total de 11 = escala 10
  });
});
