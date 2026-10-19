import { describe, expect, it } from 'vitest';
import { filtrarDifuso, normalizar, puntaje } from './difuso';

describe('filtro difuso', () => {
  it('ignora acentos y mayúsculas', () => {
    expect(normalizar('Aproximación de Chebyshev')).toBe('aproximacion de chebyshev');
    expect(puntaje('Desnormalización', 'desnormalizacion')).not.toBeNull();
    expect(puntaje('Desnormalización', 'DESNORM')).not.toBeNull();
  });

  it('cada palabra de la consulta tiene que estar, en cualquier orden', () => {
    expect(puntaje('Secciones/Aproximación de Cauer.tex', 'cauer aprox')).not.toBeNull();
    expect(puntaje('Secciones/Aproximación de Cauer.tex', 'cauer butter')).toBeNull();
  });

  it('acepta letras salteadas en orden pero no desordenadas', () => {
    expect(puntaje('abrir capítulo', 'abrc')).not.toBeNull();
    expect(puntaje('abrir capítulo', 'cbra')).toBeNull();
  });

  it('gana lo que coincide al empezar una palabra, antes y en un texto más corto', () => {
    const lista = ['Funciones de Aproximación', 'Aproximación de Butterworth', 'Anexo con aproximaciones', 'Apuntes'];
    const r = filtrarDifuso(lista, 'aprox', (x) => x);
    expect(r[0]).toBe('Aproximación de Butterworth');
    // Después, el que la tiene más cerca del principio.
    expect(r).toEqual(['Aproximación de Butterworth', 'Anexo con aproximaciones', 'Funciones de Aproximación']);
  });

  it('una consulta vacía devuelve todo en su orden y respeta el tope', () => {
    const lista = ['b', 'a', 'c'];
    expect(filtrarDifuso(lista, '  ', (x) => x)).toEqual(['b', 'a', 'c']);
    expect(filtrarDifuso(lista, '', (x) => x, 2)).toEqual(['b', 'a']);
  });

  it('los empates conservan el orden original', () => {
    const lista = ['uno x', 'dos x', 'tre x'];
    expect(filtrarDifuso(lista, 'x', (x) => x)).toEqual(lista);
  });

  it('sin coincidencias, vacío', () => {
    expect(filtrarDifuso(['uno', 'dos'], 'zzz', (x) => x)).toEqual([]);
  });
});
