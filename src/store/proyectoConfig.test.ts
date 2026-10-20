import { describe, expect, it } from 'vitest';
import {
  aplicarSeccion,
  aTexto,
  comandosDeParte,
  fijarComandosDeParte,
  fijarFiguras,
  fijarFlag,
  fijarPerfil,
  fijarRaiz,
  fijarSalidas,
  fijarVariable,
  figurasDe,
  nombreDeExportacion,
  parsear,
  quitarPerfil,
  quitarVariable,
  salidasDe,
  usoDeFlag,
  type ConfigJson,
} from './proyectoConfig';

const libro = (): ConfigJson => ({
  root: 'Funciones de Aproximación.tex',
  engine: 'pdflatex',
  parts: { commands: ['include', 'Capitulo'] },
  flags: { partial: ['CompilacionReducida'], externalize: ['TikzExternalizar'], figureList: ['TikzListaYMake'] },
  figureCache: { mode: 'project', dir: 'figuras-cache', stampFiles: ['estilo_figuras.tex'], onlyInFigureEnv: true, parallelJobs: 'auto', extra: 1 },
  profiles: { parcial: { label: 'Partes elegidas', partial: true, parts: 'selection' } },
  publish: { dir: '../PDF', names: { entrega: 'Libro.pdf' } },
  export: { dir: '../PDF/Capítulos', pattern: '{num:02} - {name}.pdf' },
  desconocida: { algo: true },
});

describe('edición de latexviewer.json', () => {
  it('el texto sale con sangría de 2 y salto final, y se lee de vuelta; lo que no es un objeto no se acepta', () => {
    const t = aTexto({ root: 'a.tex' });
    expect(t).toBe('{\n  "root": "a.tex"\n}\n');
    expect(parsear(t)).toEqual({ root: 'a.tex' });
    expect(parsear('[1]')).toBeNull();
    expect(parsear('{ roto')).toBeNull();
  });

  it('ninguna función muta lo que recibe y todas conservan lo que no tocan, las claves desconocidas incluidas', () => {
    const c = libro();
    const copia = JSON.stringify(c);
    const nuevos = [
      fijarRaiz(c, 'otro.tex'),
      fijarComandosDeParte(c, ['include']),
      fijarFlag(c, 'X', 'partial'),
      fijarFiguras(c, { modo: 'off', dir: '', stampFiles: [] }),
      fijarPerfil(c, 'parcial', { label: 'Otro' }),
      quitarPerfil(c, 'parcial'),
      fijarSalidas(c, { publicar: '', exportar: '', patron: '' }),
      fijarVariable(c, 'V', { choices: ['a', 'b'] }),
    ];
    expect(JSON.stringify(c)).toBe(copia);
    for (const n of nuevos) expect(n.desconocida).toEqual({ algo: true });
  });

  it('la raíz y los comandos de parte; sin comandos vuelve `include`', () => {
    expect(fijarRaiz(libro(), 'otro.tex').root).toBe('otro.tex');
    expect(comandosDeParte(libro())).toEqual(['include', 'Capitulo']);
    expect(comandosDeParte({})).toEqual(['include']);
    expect(fijarComandosDeParte(libro(), [' include ', 'Capitulo', 'Capitulo', '']).parts?.commands).toEqual(['include', 'Capitulo']);
    expect(fijarComandosDeParte(libro(), ['', ' ']).parts?.commands).toEqual(['include']);
  });

  it('una macro está en una sola lista de flags: al cambiarle el uso se saca de la anterior', () => {
    const c = libro();
    expect(usoDeFlag(c, 'CompilacionReducida')).toBe('partial');
    expect(usoDeFlag(c, 'Otra')).toBe('ninguno');
    const d = fijarFlag(c, 'CompilacionReducida', 'externalize');
    expect(d.flags).toEqual({ partial: [], externalize: ['TikzExternalizar', 'CompilacionReducida'], figureList: ['TikzListaYMake'] });
    expect(fijarFlag(d, 'CompilacionReducida', 'ninguno').flags?.externalize).toEqual(['TikzExternalizar']);
    expect(fijarFlag({}, 'Nueva', 'figureList').flags).toEqual({ partial: [], externalize: [], figureList: ['Nueva'] });
  });

  it('las figuras: apagar saca la sección, encender la arma, y cambiar el modo conserva el resto', () => {
    expect(figurasDe(libro())).toEqual({ modo: 'project', dir: 'figuras-cache', stampFiles: ['estilo_figuras.tex'] });
    expect(figurasDe({})).toEqual({ modo: 'off', dir: 'figuras-cache', stampFiles: [] });
    expect(fijarFiguras(libro(), { modo: 'off', dir: 'x', stampFiles: [] }).figureCache).toBeUndefined();
    const app = fijarFiguras(libro(), { modo: 'app', dir: 'cache', stampFiles: ['estilo.tex', ' '] });
    expect(app.figureCache).toMatchObject({ mode: 'app', dir: 'cache', stampFiles: ['estilo.tex'], onlyInFigureEnv: true, parallelJobs: 'auto', extra: 1 });
    expect(fijarFiguras({}, { modo: 'project', dir: '', stampFiles: [] }).figureCache).toEqual({ onlyInFigureEnv: true, parallelJobs: 'auto', mode: 'project', dir: 'figuras-cache' });
  });

  it('un perfil no escribe lo que vale lo mismo que el valor por omisión', () => {
    const c = fijarPerfil({}, 'rapido', { label: 'Todo', partial: true, externalize: false, parts: 'all', autoCompile: true, cleanBefore: false });
    expect(c.profiles).toEqual({ rapido: { label: 'Todo', partial: true } });
    const d = fijarPerfil(c, 'rapido', { parts: 'selection', autoCompile: false });
    expect(d.profiles?.rapido).toEqual({ label: 'Todo', partial: true, parts: 'selection', autoCompile: false });
    expect(quitarPerfil(d, 'rapido').profiles).toEqual({});
  });

  it('las salidas: una carpeta vacía quita la sección y los nombres por perfil se conservan', () => {
    expect(salidasDe(libro())).toEqual({ publicar: '../PDF', exportar: '../PDF/Capítulos', patron: '{num:02} - {name}.pdf' });
    expect(salidasDe({})).toEqual({ publicar: '', exportar: '', patron: '{num:02} - {name}.pdf' });
    const c = fijarSalidas(libro(), { publicar: 'afuera/PDF', exportar: 'afuera/PDF/Caps', patron: '{num} {name}.pdf' });
    expect(c.publish).toEqual({ dir: 'afuera/PDF', names: { entrega: 'Libro.pdf' } });
    expect(c.export).toEqual({ dir: 'afuera/PDF/Caps', pattern: '{num} {name}.pdf' });
    const sin = fijarSalidas(libro(), { publicar: '', exportar: '', patron: '{num:02} - {name}.pdf' });
    expect(sin.publish).toBeUndefined();
    expect(sin.export).toBeUndefined();
    expect(fijarSalidas({}, { publicar: '', exportar: '', patron: '{name}.pdf' }).export).toEqual({ dir: 'export', pattern: '{name}.pdf' });
  });

  it('las variables se agregan, se cambian y se quitan; sin ninguna, la sección desaparece', () => {
    const c = fijarVariable({}, 'OpcionPie', { label: 'Pie', choices: ['completo', 'autor'], default: 'completo' });
    expect(c.variables?.OpcionPie.choices).toEqual(['completo', 'autor']);
    expect(quitarVariable(c, 'OpcionPie').variables).toBeUndefined();
    expect(quitarVariable(fijarVariable(c, 'Otra', { choices: ['x'] }), 'OpcionPie').variables).toEqual({ Otra: { choices: ['x'] } });
  });

  it('«usar lo detectado» copia sólo la sección pedida (o la saca si la detección no la tiene)', () => {
    const mio: ConfigJson = { root: 'mio.tex', parts: { commands: ['include'] }, profiles: { a: {} }, publish: { dir: 'x' }, export: { dir: 'y' }, figureCache: { mode: 'app' } };
    const detectado: ConfigJson = { root: 'det.tex', parts: { commands: ['include', 'Capitulo'] }, profiles: { b: { partial: true } } };
    expect(aplicarSeccion(mio, detectado, 'raiz').root).toBe('det.tex');
    expect(aplicarSeccion(mio, detectado, 'raiz').profiles).toEqual({ a: {} });
    expect(aplicarSeccion(mio, detectado, 'partes').parts).toEqual({ commands: ['include', 'Capitulo'] });
    expect(aplicarSeccion(mio, detectado, 'perfiles').profiles).toEqual({ b: { partial: true } });
    const salidas = aplicarSeccion(mio, detectado, 'salidas');
    expect(salidas.publish).toBeUndefined();
    expect(salidas.export).toBeUndefined();
    expect(aplicarSeccion(mio, detectado, 'figuras').figureCache).toBeUndefined();
    expect(aplicarSeccion(mio, detectado, 'flags').flags).toBeUndefined();
  });

  it('el nombre de un PDF exportado sigue el patrón como el core', () => {
    expect(nombreDeExportacion('{num:02} - {name}.pdf', '8', 'Funciones de Aproximación')).toBe('08 - Funciones de Aproximación.pdf');
    expect(nombreDeExportacion('{num} {name}.pdf', '12', 'X')).toBe('12 X.pdf');
    expect(nombreDeExportacion('{num:03}_{name}.pdf', '7', 'Y')).toBe('007_Y.pdf');
  });
});
