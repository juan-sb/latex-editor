import { describe, expect, it } from 'vitest';
import { LogBuffer } from './logbuffer';

const todo = (b: LogBuffer) => b.slice(0, b.length);

describe('LogBuffer', () => {
  it('arma líneas a partir de fragmentos', () => {
    const b = new LogBuffer();
    b.append('uno\ndos\ntr');
    b.append('es\ncuatro');
    expect(todo(b)).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });

  it('la línea a medias sigue creciendo (pdflatex escribe [12] [13] sin saltos)', () => {
    const b = new LogBuffer();
    b.append('[1] ');
    b.append('[2] ');
    b.append('[3]');
    expect(todo(b)).toEqual(['[1] [2] [3]']);
    b.append('\nfin');
    expect(todo(b)).toEqual(['[1] [2] [3]', 'fin']);
  });

  it('un CRLF partido entre dos fragmentos no deja un \\r colgado', () => {
    const b = new LogBuffer();
    b.append('linea\r');
    b.append('\nsiguiente');
    expect(todo(b)).toEqual(['linea', 'siguiente']);
    const c = new LogBuffer();
    c.append('a\r\nb\r\n');
    expect(todo(c)).toEqual(['a', 'b', '']);
  });

  it('respeta las líneas vacías y un fragmento vacío no hace nada', () => {
    const b = new LogBuffer();
    const v = b.getVersion();
    b.append('');
    expect(b.getVersion()).toBe(v);
    b.append('\n\nx');
    expect(todo(b)).toEqual(['', '', 'x']);
  });

  it('recorta lo más viejo al pasar el tope y cuenta lo descartado', () => {
    const b = new LogBuffer(100);
    for (let i = 0; i < 500; i++) b.append(`linea ${i}\n`);
    expect(b.length).toBeLessThanOrEqual(111);
    expect(b.length).toBeGreaterThanOrEqual(100);
    expect(b.lineasDescartadas).toBeGreaterThan(300);
    const ultimas = todo(b);
    expect(ultimas[ultimas.length - 2]).toBe('linea 499');
    expect(b.lineasDescartadas + b.length).toBe(501); // 500 líneas con salto + la línea en curso vacía
  });

  it('clear vacía y avisa; subscribe y unsubscribe', () => {
    const b = new LogBuffer();
    let llamadas = 0;
    const baja = b.subscribe(() => llamadas++);
    b.append('x\n');
    b.clear();
    expect(todo(b)).toEqual(['']);
    expect(llamadas).toBe(2);
    baja();
    b.append('y');
    expect(llamadas).toBe(2);
  });

  it('la versión cambia con cada modificación', () => {
    const b = new LogBuffer();
    const v0 = b.getVersion();
    b.append('a');
    const v1 = b.getVersion();
    b.clear();
    expect(new Set([v0, v1, b.getVersion()]).size).toBe(3);
  });
});
