import { describe, expect, it } from 'vitest';
import { buscarForward, buscarInverse, buscarRango, casiIgual, dentroDeCajas, palabraEnPunto, type PalabraPdf, type Rect } from './buscar';
import { aTextoPlano, clave, palabraEn, palabrasDeLinea } from './texto';

const palabras = (l: string) => palabrasDeLinea(l).map((p) => p.texto);

describe('texto plano de una línea de LaTeX', () => {
  it('saca comandos, llaves, matemática, referencias y comentarios, y deja el texto', () => {
    expect(palabras('Una \\textbf{palabra} con \\emph{énfasis}, ref \\ref{eq:x} y $a+b$ fin. % comentario \\textbf{no}')).toEqual([
      'Una', 'palabra', 'con', 'énfasis', 'ref', 'y', 'fin',
    ]);
    expect(palabras('Esto\\cite{k1,k2} sigue~acá y \\label{l} termina\\footnote{una nota} aquí.')).toEqual([
      'Esto', 'sigue', 'acá', 'y', 'termina', 'una', 'nota', 'aquí',
    ]);
    expect(palabras('antes \\[ x^2 \\] después \\( y \\) fin $$ z $$ cierre')).toEqual(['antes', 'después', 'fin', 'cierre']);
  });

  it('los acentos de LaTeX se componen y los símbolos escapados quedan', () => {
    expect(palabras("m\\'as y qu\\'{e} y ni\\~no y \\\"u y \\'\\i ndice")).toEqual(['más', 'y', 'qué', 'y', 'niño', 'y', 'ü', 'y', 'índice']);
    expect(aTextoPlano('100\\% de \\$5 y R\\&D').plano).toBe('100% de $5 y R&D');
    expect(palabras('\\begin{itemize} \\item Primero \\item Segundo \\end{itemize}')).toEqual(['Primero', 'Segundo']);
  });

  it('el mapa lleva cada palabra a su lugar exacto en la línea original', () => {
    const linea = 'Una \\textbf{palabra} con \\emph{énfasis} y $x$ final';
    for (const p of palabrasDeLinea(linea)) {
      // El texto original entre inicio y fin contiene la palabra (sin los comandos que la rodeen).
      expect(linea.slice(p.inicio, p.fin)).toBe(p.texto);
    }
    // Un acento de LaTeX ocupa más en el original que la letra compuesta: el rango cubre el acento entero.
    const q = palabrasDeLinea("el m\\'as grande")[1];
    expect(q.texto).toBe('más');
    expect("el m\\'as grande".slice(q.inicio, q.fin)).toBe("m\\'as");
  });

  it('la clave ignora acentos, mayúsculas, ligaduras y signos', () => {
    expect(clave('Física')).toBe('fisica');
    expect(clave('ﬁnal')).toBe('final');
    expect(clave('co-')).toBe('co');
    expect(clave('(H(s))')).toBe('hs');
    expect(clave('—')).toBe('');
  });

  it('la palabra en una posición es la que la contiene o la más cercana', () => {
    const p = palabrasDeLinea('uno dos  tres');
    expect(palabraEn(p, 5)).toBe(1);
    expect(palabraEn(p, 7)).toBe(1); // entre dos y tres, más cerca de dos (termina en 7)
    expect(palabraEn(p, 100)).toBe(2);
    expect(palabraEn([], 3)).toBe(-1);
  });
});

/** Un renglón de PDF: palabras de ancho proporcional al largo, en fila desde `x0`. */
function renglon(texto: string, y: number, page = 1, x0 = 72): PalabraPdf[] {
  let x = x0;
  return texto.split(' ').map((t) => {
    const w = t.length * 5;
    const p: PalabraPdf = { texto: t, clave: clave(t), page, x, y, w, h: 10 };
    x += w + 3;
    return p;
  }).filter((p) => p.clave);
}

const caja = (y: number, h = 12, page = 1): Rect => ({ page, x: 60, y: y - 1, w: 480, h });

describe('del fuente al PDF', () => {
  const pdf = [
    ...renglon('La desnormalización transforma una función de', 100),
    ...renglon('transferencia normalizada en una de las que cumple', 114),
    ...renglon('la plantilla real de una función de transferencia', 128),
    ...renglon('otro párrafo que no es éste', 300),
  ];
  const cajas = [caja(100), caja(114), caja(128)];
  const fuente = palabrasDeLinea(
    'La desnormalización transforma una función de transferencia normalizada en una de las que cumple la plantilla real de una función de transferencia',
  );
  const quien = (r: { rects: Rect[] } | null) => r?.rects.map((x) => `${x.page}:${Math.round(x.x)},${Math.round(x.y)}`);

  it('encuentra la palabra adentro de las cajas', () => {
    const k = fuente.findIndex((p) => p.clave === 'plantilla');
    const r = buscarForward(fuente, k, pdf, cajas);
    expect(r?.rects).toHaveLength(1);
    expect(r!.rects[0].y).toBe(128);
    expect(r!.contexto).toBeGreaterThanOrEqual(2);
  });

  it('una palabra repetida se resuelve por el contexto, no por la primera aparición', () => {
    // "función de transferencia" aparece dos veces en el fuente (la segunda, al final del párrafo) y en el PDF.
    const ultimaFuncion = fuente.map((p) => p.clave).lastIndexOf('funcion');
    const r = buscarForward(fuente, ultimaFuncion, pdf, cajas);
    expect(r!.rects[0].y).toBe(128);
    const primera = fuente.findIndex((p) => p.clave === 'funcion');
    expect(buscarForward(fuente, primera, pdf, cajas)!.rects[0].y).toBe(100);
  });

  it('una palabra muy repetida sin contexto que la distinga se resuelve por la posición relativa', () => {
    const de = fuente.map((p, i) => (p.clave === 'de' ? i : -1)).filter((i) => i >= 0);
    const a = buscarForward(fuente, de[0], pdf, cajas)!;
    const z = buscarForward(fuente, de[de.length - 1], pdf, cajas)!;
    expect(a.rects[0].y).toBeLessThan(z.rects[0].y);
  });

  it('lo que está fuera de las cajas no cuenta', () => {
    const solo = [caja(300)];
    expect(buscarForward(fuente, fuente.findIndex((p) => p.clave === 'plantilla'), pdf, solo)).toBeNull();
    expect(dentroDeCajas(pdf, solo).map((p) => p.y)).toEqual([300, 300, 300, 300, 300, 300]);
  });

  it('una palabra cortada con guion al final de línea se encuentra en sus dos mitades', () => {
    const cortado = [...renglon('La desnorma-', 100), ...renglon('lización transforma una función', 114)];
    const k = fuente.findIndex((p) => p.clave === 'desnormalizacion');
    const r = buscarForward(fuente, k, cortado, [caja(100), caja(114)]);
    expect(r?.rects).toHaveLength(2);
    expect(quien(r)).toEqual(['1:85,100', '1:72,114']);
  });

  it('tolera una letra distinta (una ligadura o un acento mal copiados) y no inventa lo que no está', () => {
    expect(casiIgual('transformacion', 'transformacian')).toBe(true);
    expect(casiIgual('cuatro', 'cuadro')).toBe(true);
    expect(casiIgual('casa', 'cosa')).toBe(false); // corta: no se tolera
    const roto = [...renglon('La desnormalizacian transforma una', 100)];
    const k = fuente.findIndex((p) => p.clave === 'desnormalizacion');
    expect(buscarForward(fuente, k, roto, [caja(100)])?.rects).toHaveLength(1);
    expect(buscarForward(fuente, 0, [], [caja(100)])).toBeNull();
    expect(buscarForward([], 0, pdf, cajas)).toBeNull();
  });

  it('con la matemática en el medio el contexto se corta pero la palabra se encuentra igual', () => {
    const f = palabrasDeLinea('El módulo de $H(s)$ vale uno cuando la frecuencia es cero.');
    const p = [...renglon('El módulo de H ( s ) vale uno cuando la frecuencia es cero.', 100)];
    const k = f.findIndex((x) => x.clave === 'frecuencia');
    const r = buscarForward(f, k, p, [caja(100)]);
    expect(r).not.toBeNull();
    expect(r!.rects[0].x).toBeGreaterThan(150);
  });
});

describe('un tramo del fuente al PDF (lo seleccionado en el editor)', () => {
  const pdf = [
    ...renglon('La desnormalización transforma una función de', 100),
    ...renglon('transferencia normalizada en una de las que cumple', 114),
    ...renglon('la plantilla real de una función de transferencia', 128),
    ...renglon('otro párrafo que no es éste', 300),
  ];
  const cajas = [caja(100), caja(114), caja(128)];
  const fuente = palabrasDeLinea('La desnormalización transforma una función de transferencia normalizada en una de las que cumple la plantilla real de una función de transferencia');
  const i = (c: string) => fuente.findIndex((p) => p.clave === c);

  it('un tramo adentro de un renglón da una sola caja que va de la primera palabra a la última', () => {
    const r = buscarRango(fuente, i('desnormalizacion'), i('una'), pdf, cajas)!;
    expect(r.rects).toHaveLength(1);
    const primera = pdf.find((p) => p.clave === 'desnormalizacion')!;
    const ultima = pdf.find((p) => p.clave === 'una')!;
    expect(r.rects[0]).toEqual({ page: 1, x: primera.x, y: 100, w: ultima.x + ultima.w - primera.x, h: 10 });
  });

  it('un tramo que cruza renglones da una caja por renglón, y la del medio ocupa el renglón entero', () => {
    const r = buscarRango(fuente, i('funcion'), i('normalizada'), pdf, cajas)!;
    expect(r.rects.map((x) => x.y)).toEqual([100, 114]);
    const transferencia = pdf.find((p) => p.clave === 'transferencia' && p.y === 114)!;
    const normalizada = pdf.find((p) => p.clave === 'normalizada')!;
    expect(r.rects[1].x).toBe(transferencia.x);
    expect(r.rects[1].x + r.rects[1].w).toBe(normalizada.x + normalizada.w);
    const largo = buscarRango(fuente, i('desnormalizacion'), fuente.length - 1, pdf, cajas)!;
    expect(largo.rects.map((x) => x.y)).toEqual([100, 114, 128]); // tres renglones: todo el párrafo
  });

  it('con una sola palabra es lo mismo que buscarForward, y sin la punta final se queda con la primera', () => {
    const k = i('plantilla');
    expect(buscarRango(fuente, k, k, pdf, cajas)!.rects).toEqual(buscarForward(fuente, k, pdf, cajas)!.rects);
    // Una palabra del fuente que el PDF no tiene (por ejemplo, la sacó una macro): se resalta lo que sí se encontró.
    const raro = palabrasDeLinea('La desnormalización transforma palabrainexistente');
    const r = buscarRango(raro, 0, 3, pdf, cajas)!;
    expect(r.rects).toHaveLength(1);
    expect(r.rects[0].y).toBe(100);
    expect(buscarRango(palabrasDeLinea('zzz qqq'), 0, 1, pdf, cajas)).toBeNull();
  });

  it('un hasta anterior al desde no da un rectángulo al revés', () => {
    const r = buscarRango(fuente, i('plantilla'), i('desnormalizacion'), pdf, cajas)!;
    expect(r.rects).toHaveLength(1);
    expect(r.rects[0].w).toBeGreaterThan(0);
  });
});

describe('del PDF al fuente', () => {
  const lineas = [
    { n: 10, texto: 'Primero se define la función de transferencia normalizada del filtro.' },
    { n: 11, texto: 'La desnormalización transforma una función de transferencia en otra distinta de la anterior.' },
    { n: 12, texto: 'Por último se calcula la plantilla real que cumple el diseño pedido.' },
  ];
  const pdf = [
    ...renglon('La desnormalización transforma una función de transferencia', 100),
    ...renglon('en otra distinta de la anterior. Por último', 114),
  ];
  const en = (t: string) => pdf.findIndex((p) => p.clave === clave(t));

  it('el clic en una palabra va a su lugar exacto: línea, inicio y fin', () => {
    const r = buscarInverse(lineas, 11, pdf, en('distinta'))!;
    expect(r.line).toBe(11);
    expect(lineas[1].texto.slice(r.inicio, r.fin)).toBe('distinta');
  });

  it('una palabra repetida se resuelve por las vecinas y por la cercanía a la línea de SyncTeX', () => {
    // "función de transferencia" está en las líneas 10 y 11. Sin vecinas que distingan, manda la cercanía a la línea de SyncTeX.
    const solas = renglon('función de transferencia', 100);
    expect(buscarInverse(lineas, 11, solas, 0)!.line).toBe(11);
    expect(buscarInverse(lineas, 10, solas, 0)!.line).toBe(10);
    // Con las vecinas del PDF ("una" antes) gana la línea cuyo contexto coincide, aunque SyncTeX apunte a la de al lado.
    expect(buscarInverse(lineas, 10, pdf, en('funcion'))!.line).toBe(11);
  });

  it('las vecinas desempatan aunque SyncTeX apunte a la línea de al lado', () => {
    // Se clickea "transferencia" del PDF, que tiene "función de" antes y "en otra" después: sólo la línea 11 coincide.
    const k = pdf.findIndex((p) => p.clave === 'transferencia');
    const r = buscarInverse(lineas, 12, pdf, k)!;
    expect(r.line).toBe(11);
    expect(r.contexto).toBeGreaterThanOrEqual(2);
  });

  it('una palabra cortada con guion se encuentra clickeando cualquiera de sus mitades', () => {
    const cortado = [...renglon('La desnorma-', 100), ...renglon('lización transforma una función', 114)];
    for (const mitad of ['desnorma-', 'lización']) {
      const k = cortado.findIndex((p) => p.texto === mitad);
      const r = buscarInverse(lineas, 11, cortado, k)!;
      expect(lineas[1].texto.slice(r.inicio, r.fin)).toBe('desnormalización');
    }
  });

  it('si la palabra no está en esas líneas devuelve null y quien llama se queda con la línea', () => {
    const otro = renglon('zzzzzz', 100);
    expect(buscarInverse(lineas, 11, otro, 0)).toBeNull();
    expect(buscarInverse(lineas, 11, [], 0)).toBeNull();
  });

  it('el punto cae en la palabra que lo contiene o en la más cercana de su línea', () => {
    const fila = renglon('uno dos tres', 100);
    expect(palabraEnPunto(fila, 1, fila[1].x + 2, 105)).toBe(1);
    expect(palabraEnPunto(fila, 1, 5, 105)).toBe(0); // a la izquierda de todo
    const dos = [...renglon('arriba', 100), ...renglon('abajo', 114)];
    expect(palabraEnPunto(dos, 1, 80, 113)).toBe(1); // más cerca de la línea de abajo
    expect(palabraEnPunto(dos, 2, 80, 113)).toBe(-1); // otra página: sin texto
  });
});
