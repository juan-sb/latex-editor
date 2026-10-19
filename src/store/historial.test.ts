import { describe, expect, it } from 'vitest';
import type { EntradaHistorial, Hallazgo } from '../backend';
import { contarHallazgos, duracion, motivoCorto, ordenarHallazgos, resultado, resumen } from './historial';

const entrada = (o: Partial<EntradaHistorial>): EntradaHistorial => ({ inicioMs: 0, tipo: 'build', motivo: 'manual', ms: 0, ok: true, pistas: [], ...o });
const hallazgo = (id: string, nivel: Hallazgo['nivel']): Hallazgo => ({ id, nivel, titulo: id, detalle: '', arreglo: null, archivo: null, linea: null });

describe('historial', () => {
  it('la duración se escribe corta', () => {
    expect([duracion(850), duracion(4100), duracion(12400), duracion(65000), duracion(338000)]).toEqual(['850 ms', '4.1 s', '12 s', '1 min 05 s', '5 min 38 s']);
  });

  it('el motivo de un guardado o de un cambio de afuera lleva los nombres de archivo y no las rutas', () => {
    expect(motivoCorto('guardado: Cap/uno.tex')).toBe('guardado: uno.tex');
    expect(motivoCorto('afuera: A/x.tex, B/y.tex y 2 más')).toBe('afuera: x.tex, y.tex y 2 más');
    expect(motivoCorto('antes del build de parcial')).toBe('antes del build de parcial');
  });

  it('el resultado distingue cancelado de fallido, y el resumen cuenta lo propio de cada tipo', () => {
    expect(resultado(entrada({ ok: false, cancelado: true }))).toBe('cancelled');
    expect(resultado(entrada({ ok: false }))).toBe('fail');
    expect(resumen(entrada({ pasadas: 2, errores: 1, avisos: 3 }))).toBe('2 pasadas, 1 error, 3 avisos');
    expect(resumen(entrada({ tipo: 'bake', cocidas: 46, fallidas: 1, cedio: true, restantes: 100 }))).toBe('46 cocidas, 1 fallida, cedió el paso (quedaban 100)');
    expect(resumen(entrada({ tipo: 'export', partes: [{ parte: 'a', num: '1', ms: 1, ok: true }, { parte: 'b', num: null, ms: 1, ok: false }] }))).toBe('1 de 2 partes');
  });

  it('el doctor pone lo grave primero y conserva el orden dentro de cada nivel', () => {
    const h = [hallazgo('a', 'ok'), hallazgo('b', 'aviso'), hallazgo('c', 'error'), hallazgo('d', 'aviso'), hallazgo('e', 'info')];
    expect(ordenarHallazgos(h).map((x) => x.id)).toEqual(['c', 'b', 'd', 'e', 'a']);
    expect(contarHallazgos(h)).toEqual({ error: 1, aviso: 2, info: 1, ok: 1 });
  });
});
