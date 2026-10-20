import { describe, expect, it } from 'vitest';
import { duracionCorta, lineaDeBuild, nombreDeFigura, textoDeFigura, textoDePaso, textoDeTipico } from './barra';

describe('barra mientras compila', () => {
  it('la pasada lleva su número sólo para el motor, y la herramienta que corre una sola vez va sin número', () => {
    expect(textoDePaso(null)).toBe('');
    expect(textoDePaso({ tool: 'pdflatex', n: 2 })).toBe('pasada 2 · pdflatex');
    expect(textoDePaso({ tool: 'xelatex', n: 1 })).toBe('pasada 1 · xelatex');
    expect(textoDePaso({ tool: 'biber', n: 1 })).toBe('biber');
    expect(textoDePaso({ tool: 'makeindex', n: 2 })).toBe('makeindex 2');
  });

  it('la figura que cocina pgf se nombra sin el sello ni la carpeta', () => {
    expect(nombreDeFigura('C7C9E7-butter-2')).toBe('butter-2');
    expect(nombreDeFigura('figuras-cache/C7C9E7-anexocauer-0')).toBe('anexocauer-0');
    expect(nombreDeFigura('figura-sin-sello-1')).toBe('figura-sin-sello-1');
    expect(textoDeFigura({ n: 3, nombre: 'C7C9E7-butter-2' })).toBe('cocinando figura 3: butter-2');
    expect(textoDeFigura(null)).toBe('');
  });

  it('el típico se escribe corto y avisa cuando el build se pasó por mucho', () => {
    const t = { ms: 28_000, pasadas: 2, n: 8 };
    expect(textoDeTipico(undefined, 10)).toBe('');
    expect(textoDeTipico({ ...t, ms: 0 }, 10)).toBe('');
    expect(textoDeTipico(t, 10)).toBe('típico 28 s');
    expect(textoDeTipico(t, 40)).toBe('típico 28 s'); // 40 s contra 28 s todavía es normal
    expect(textoDeTipico(t, 60)).toBe('típico 28 s · más lento que lo típico');
    expect(textoDeTipico({ ...t, ms: 65_000 }, 10)).toBe('típico 1 min 05 s');
    expect(duracionCorta(59.6)).toBe('1 min 00 s');
  });

  it('la línea junta perfil, partes, paso y figura y salta lo que no hay', () => {
    expect(lineaDeBuild({ perfil: 'Partes elegidas', partes: '3 de 8 partes', paso: { tool: 'pdflatex', n: 1 }, figura: { n: 3, nombre: 'C7C9E7-butter-2' } })).toBe(
      'Compilando «Partes elegidas» · 3 de 8 partes · pasada 1 · pdflatex · cocinando figura 3: butter-2',
    );
    expect(lineaDeBuild({ perfil: 'Libro rápido', partes: '', paso: null, figura: null })).toBe('Compilando «Libro rápido»');
  });
});
