import { describe, expect, it } from 'vitest';
import { diffCompacto, diffDeLineas, resumenDeDiff } from './diff';

describe('diff de latexviewer.json', () => {
  it('un archivo que no existe se agrega entero', () => {
    const d = diffDeLineas(null, '{\n  "root": "a.tex"\n}\n');
    expect(d.map((x) => x.tipo)).toEqual(['agrega', 'agrega', 'agrega']);
    expect(resumenDeDiff(d)).toEqual({ agregadas: 3, quitadas: 0, iguales: 0 });
  });

  it('dos textos iguales no tienen cambios, aunque uno venga con CRLF', () => {
    const d = diffDeLineas('{\r\n  "a": 1\r\n}\r\n', '{\n  "a": 1\n}\n');
    expect(resumenDeDiff(d)).toEqual({ agregadas: 0, quitadas: 0, iguales: 3 });
  });

  it('marca lo que sale y lo que entra, en el lugar donde ocurre', () => {
    const antes = ['{', '  "root": "cap_actual.tex",', '  "engine": "pdflatex"', '}'].join('\n');
    const despues = ['{', '  "root": "libro.tex",', '  "engine": "pdflatex",', '  "parts": {}', '}'].join('\n');
    const d = diffDeLineas(antes, despues);
    expect(d.map((x) => `${x.tipo === 'igual' ? ' ' : x.tipo === 'agrega' ? '+' : '-'}${x.texto}`)).toEqual([
      ' {',
      '-  "root": "cap_actual.tex",',
      '-  "engine": "pdflatex"',
      '+  "root": "libro.tex",',
      '+  "engine": "pdflatex",',
      '+  "parts": {}',
      ' }',
    ]);
  });

  it('el diff compacto saltea los tramos largos sin cambios y los cuenta', () => {
    const base = Array.from({ length: 30 }, (_, i) => `linea ${i}`);
    const cambiado = [...base];
    cambiado[15] = 'otra';
    const c = diffCompacto(diffDeLineas(base.join('\n'), cambiado.join('\n')), 2);
    expect(c[0]).toEqual({ tipo: 'salto', texto: '… 13 líneas sin cambios' });
    expect(c.filter((x) => x.tipo === 'quita' || x.tipo === 'agrega')).toHaveLength(2);
    expect(c[c.length - 1]).toEqual({ tipo: 'salto', texto: '… 12 líneas sin cambios' });
    expect(diffCompacto(diffDeLineas('a\nb', 'a\nb'))).toEqual([{ tipo: 'salto', texto: '… 2 líneas sin cambios' }]);
  });
});
