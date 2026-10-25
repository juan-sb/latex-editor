import { describe, expect, it } from 'vitest';
import { siguienteTema, temaDeTexto, temaEfectivo } from './tema';

describe('tema', () => {
  it('el efectivo sale de la elección y del sistema', () => {
    expect(temaEfectivo('sistema', false)).toBe('light');
    expect(temaEfectivo('sistema', true)).toBe('dark');
    expect(temaEfectivo('claro', true)).toBe('light');
    expect(temaEfectivo('claro', false)).toBe('light');
    expect(temaEfectivo('oscuro', false)).toBe('dark');
    expect(temaEfectivo('oscuro', true)).toBe('dark');
  });

  it('alterna sistema, claro, oscuro y vuelve', () => {
    expect(siguienteTema('sistema')).toBe('claro');
    expect(siguienteTema('claro')).toBe('oscuro');
    expect(siguienteTema('oscuro')).toBe('sistema');
  });

  it('lee preferencias.json y ante cualquier cosa rara usa el sistema', () => {
    expect(temaDeTexto('{"tema":"oscuro"}')).toBe('oscuro');
    expect(temaDeTexto('{"tema":"claro"}')).toBe('claro');
    expect(temaDeTexto(null)).toBe('sistema');
    expect(temaDeTexto('')).toBe('sistema');
    expect(temaDeTexto('{no es json')).toBe('sistema');
    expect(temaDeTexto('{"tema":"violeta"}')).toBe('sistema');
    expect(temaDeTexto('null')).toBe('sistema');
  });
});
