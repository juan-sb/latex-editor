import { describe, expect, it } from 'vitest';
import { entornos, fragmentoDelCursor } from './fragmento';

const TEXTO = [
  'Un párrafo antes de todo.',
  '',
  '\\begin{figure}[H]',
  '  \\centering',
  '  \\begin{tikzpicture}',
  '    \\draw (0,0) -- (1,1);',
  '  \\end{tikzpicture}',
  '  \\caption{Una figura.}',
  '\\end{figure}',
  '',
  'Otro párrafo, con \\ref{x} adentro,',
  'en dos líneas.',
  '',
  '\\begin{equation}',
  '  a = b',
  '\\end{equation}',
].join('\n');

const en = (marca: string, delta = 0) => TEXTO.indexOf(marca) + delta;

describe('fragmento de la vista previa', () => {
  it('una selección se compila tal cual', () => {
    const f = fragmentoDelCursor(TEXTO, en('Otro'), en('Otro') + 10);
    expect(f).toMatchObject({ tipo: 'seleccion', texto: 'Otro párra' });
    expect(fragmentoDelCursor(TEXTO, 5, 2)?.texto).toBe(TEXTO.slice(2, 5)); // al revés también
    expect(fragmentoDelCursor('   \n  ', 0, 4)).toBeNull();
  });

  it('sin selección es el entorno más interno que rodea al cursor', () => {
    const f = fragmentoDelCursor(TEXTO, en('a = b'), en('a = b'));
    expect(f).toMatchObject({ tipo: 'entorno', nombre: 'equation' });
    expect(f?.texto).toBe('\\begin{equation}\n  a = b\n\\end{equation}');
  });

  it('un dibujo dentro de un figure compila el figure entero, con su caption', () => {
    const f = fragmentoDelCursor(TEXTO, en('\\draw'), en('\\draw'));
    expect(f).toMatchObject({ tipo: 'entorno', nombre: 'figure' });
    expect(f?.texto.startsWith('\\begin{figure}[H]') && f.texto.endsWith('\\end{figure}') && f.texto.includes('\\caption')).toBe(true);
    // Desde el \caption, que ya es del figure, da lo mismo.
    expect(fragmentoDelCursor(TEXTO, en('\\caption'), en('\\caption'))?.nombre).toBe('figure');
  });

  it('un tikzpicture que no está en un flotante se compila solo', () => {
    const t = 'texto\n\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}\nmás texto';
    const f = fragmentoDelCursor(t, t.indexOf('\\draw'), t.indexOf('\\draw'));
    expect(f).toMatchObject({ tipo: 'entorno', nombre: 'tikzpicture' });
  });

  it('fuera de todo entorno es el párrafo (con sus dos líneas, sin los vecinos)', () => {
    const f = fragmentoDelCursor(TEXTO, en('en dos líneas', 3), en('en dos líneas', 3));
    expect(f).toMatchObject({ tipo: 'parrafo' });
    expect(f?.texto).toBe('Otro párrafo, con \\ref{x} adentro,\nen dos líneas.');
    expect(fragmentoDelCursor(TEXTO, 3, 3)?.texto).toBe('Un párrafo antes de todo.');
  });

  it('el entorno `document` no cuenta y un entorno comentado tampoco', () => {
    const t = '\\begin{document}\nHola\n\n% \\begin{figure}\nchau\n% \\end{figure}\n\\end{document}';
    expect(fragmentoDelCursor(t, t.indexOf('Hola'), t.indexOf('Hola'))?.tipo).toBe('parrafo');
    expect(entornos(t).map((e) => e.nombre)).toEqual(['document']);
  });

  it('un entorno sin cerrar se ignora y se cae al párrafo', () => {
    const t = 'Antes.\n\n\\begin{figure}\nsin cierre\n\nDespués.';
    const f = fragmentoDelCursor(t, t.indexOf('sin cierre'), t.indexOf('sin cierre'));
    expect(f?.tipo).toBe('parrafo');
    expect(f?.texto).toBe('\\begin{figure}\nsin cierre');
  });
});
