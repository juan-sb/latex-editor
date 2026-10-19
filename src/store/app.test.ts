import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError, setBackend, type Backend, type BuildEvent, type Eol, type ProjectInfo } from '../backend';
import { cerrarTodos, editarDoc, getDoc } from '../editor/docs';
import { useApp } from './app';
import { logBuffer } from './logbuffer';

interface Archivo {
  text: string;
  version: string;
  eol: Eol;
  bom: boolean;
  mixed: boolean;
}

/** Un backend en memoria que registra qué se le pidió y en qué orden. */
function falso(archivos: Record<string, Partial<Archivo> & { text: string }>, proyecto?: Partial<ProjectInfo>) {
  const llamadas: string[] = [];
  const disco = new Map<string, Archivo>(
    Object.entries(archivos).map(([k, v]) => [k, { version: 'v0', eol: 'lf', bom: false, mixed: false, ...v }]),
  );
  let n = 1;
  const control = { demoraEscritura: null as Promise<void> | null };
  const b: Backend = {
    launchOptions: async () => ({ open: null, root: null, smoke: false, smokeFile: null, smokePausaMs: 0 }),
    pickFolder: async () => '/p',
    openProject: async (path) => ({ name: 'p', root: path, candidates: ['main.tex'], suggested: 'main.tex', ...proyecto }),
    setRootFile: async (rel) => void llamadas.push(`raiz ${rel}`),
    listDir: async () => [],
    readFile: async (rel) => {
      llamadas.push(`read ${rel}`);
      const f = disco.get(rel);
      if (!f) throw new BackendError('not_found', rel);
      if (rel.endsWith('.bin')) throw new BackendError('not_text', 'binario');
      return { ...f };
    },
    writeFile: async (rel, text, esperada) => {
      llamadas.push(`write ${rel}`);
      if (control.demoraEscritura) await control.demoraEscritura;
      const f = disco.get(rel)!;
      if (esperada !== f.version) throw new BackendError('conflict', 'cambió', f.version);
      if (f.text === text) return { written: false, version: f.version };
      f.text = text;
      f.version = `v${n++}`;
      return { written: true, version: f.version };
    },
    readPdf: async () => new Uint8Array(),
    build: async () => {
      llamadas.push('build');
      return 1;
    },
    cancelBuild: async () => true,
    onBuildEvent: async () => () => {},
    onCloseRequested: async () => () => {},
    exitApp: async () => {},
    smokeReadBytes: async () => new Uint8Array(),
    smokeMtime: async () => 0,
    writeSmokeResult: async () => {},
  };
  setBackend(b);
  return { llamadas, disco, control };
}

const st = () => useApp.getState();
const tab = (rel: string) => st().tabs.find((t) => t.rel === rel)!;

async function responder(id: string) {
  await vi.waitFor(() => expect(st().dialog).not.toBeNull());
  st().responderDialogo(id);
}

beforeEach(() => {
  cerrarTodos();
  logBuffer.clear();
  useApp.setState({
    project: { name: 'p', root: '/p', candidates: ['main.tex'], suggested: 'main.tex' },
    rootFile: 'main.tex',
    tabs: [],
    activeRel: null,
    build: { status: 'idle', id: null, ms: null, code: null, cmdline: null },
    pdfRel: null,
    pdfEpoch: 0,
    notice: null,
    dialog: null,
  });
});

describe('abrir y editar', () => {
  it('abrir crea una pestaña limpia y activa, y reabrir no vuelve a leer', async () => {
    const f = falso({ 'a.tex': { text: 'uno\n' } });
    await st().abrirArchivo('a.tex');
    expect(st().activeRel).toBe('a.tex');
    expect(tab('a.tex')).toMatchObject({ name: 'a.tex', dirty: false, readOnly: false });
    await st().abrirArchivo('a.tex');
    expect(f.llamadas.filter((l) => l === 'read a.tex')).toHaveLength(1);
    expect(st().tabs).toHaveLength(1);
  });

  it('la pestaña muestra el nombre sin la carpeta', async () => {
    falso({ 'Secciones/Capítulo uno.tex': { text: 'x' } });
    await st().abrirArchivo('Secciones/Capítulo uno.tex');
    expect(tab('Secciones/Capítulo uno.tex').name).toBe('Capítulo uno.tex');
  });

  it('un archivo que no es texto avisa y no abre pestaña', async () => {
    falso({ 'x.bin': { text: '' } });
    await st().abrirArchivo('x.bin');
    expect(st().tabs).toHaveLength(0);
    expect(st().notice?.nivel).toBe('error');
  });

  it('editar marca modificado; deshacer el cambio lo deja limpio', async () => {
    falso({ 'a.tex': { text: 'uno\ndos\n' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    expect(tab('a.tex').dirty).toBe(true);
    editarDoc('a.tex', { from: 0, to: 1 });
    expect(tab('a.tex').dirty).toBe(false);
  });
});

describe('guardar', () => {
  it('escribe con la versión leída, deja la pestaña limpia y el segundo guardado no llama al backend', async () => {
    const f = falso({ 'a.tex': { text: 'uno\n', version: 'v0' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    expect(await st().guardar('a.tex')).toBe('guardado');
    expect(f.disco.get('a.tex')!.text).toBe('Xuno\n');
    expect(tab('a.tex').dirty).toBe(false);
    expect(getDoc('a.tex')!.version).toBe('v1');
    expect(await st().guardar('a.tex')).toBe('sin-cambios');
    expect(f.llamadas.filter((l) => l === 'write a.tex')).toHaveLength(1);
    // Forzado (lo usa el smoke): llega al core, que dice que no escribió nada.
    expect(await st().guardar('a.tex', { forzar: true })).toBe('sin-cambios');
    expect(f.llamadas.filter((l) => l === 'write a.tex')).toHaveLength(2);
  });

  it('si el usuario sigue escribiendo mientras se guarda, la pestaña sigue modificada', async () => {
    const f = falso({ 'a.tex': { text: 'uno\n' } });
    let soltar!: () => void;
    f.control.demoraEscritura = new Promise<void>((r) => (soltar = r));
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'A' });
    const guardando = st().guardar('a.tex');
    editarDoc('a.tex', { from: 1, insert: 'B' }); // mientras tanto
    soltar();
    expect(await guardando).toBe('guardado');
    expect(f.disco.get('a.tex')!.text).toBe('Auno\n'); // lo que se escribió es lo de antes del await
    expect(tab('a.tex').dirty).toBe(true); // y lo nuevo sigue sin guardar
  });

  it('conflicto de versión: pregunta y, si se acepta, reintenta con la versión del disco', async () => {
    const f = falso({ 'a.tex': { text: 'uno\n', version: 'v0' } });
    await st().abrirArchivo('a.tex');
    f.disco.get('a.tex')!.version = 'v9'; // alguien lo tocó afuera
    f.disco.get('a.tex')!.text = 'cambiado afuera\n';
    editarDoc('a.tex', { from: 0, insert: 'X' });
    const g = st().guardar('a.tex');
    await responder('sobrescribir');
    expect(await g).toBe('guardado');
    expect(f.disco.get('a.tex')!.text).toBe('Xuno\n');
    expect(tab('a.tex').dirty).toBe(false);
  });

  it('conflicto de versión: si se cancela, no se pisa y la pestaña sigue modificada', async () => {
    const f = falso({ 'a.tex': { text: 'uno\n', version: 'v0' } });
    await st().abrirArchivo('a.tex');
    f.disco.get('a.tex')!.version = 'v9';
    f.disco.get('a.tex')!.text = 'cambiado afuera\n';
    editarDoc('a.tex', { from: 0, insert: 'X' });
    const g = st().guardar('a.tex');
    await responder('cancelar');
    expect(await g).toBe('cancelado');
    expect(f.disco.get('a.tex')!.text).toBe('cambiado afuera\n');
    expect(tab('a.tex').dirty).toBe(true);
  });

  it('un archivo con EOL mezclados es de sólo lectura hasta que se acepta normalizar', async () => {
    const f = falso({ 'm.tex': { text: 'uno\ndos\n', mixed: true, eol: 'crlf' } });
    await st().abrirArchivo('m.tex');
    expect(tab('m.tex')).toMatchObject({ readOnly: true, mixed: true });
    expect(st().notice?.texto).toContain('sólo lectura');
    expect(await st().guardar('m.tex')).toBe('sin-cambios');
    expect(f.llamadas).not.toContain('write m.tex');
    const epoch = tab('m.tex').epoch;
    st().hacerEditable('m.tex');
    expect(tab('m.tex')).toMatchObject({ readOnly: false });
    expect(tab('m.tex').epoch).toBe(epoch + 1);
    editarDoc('m.tex', { from: 0, insert: 'X' });
    expect(await st().guardar('m.tex')).toBe('guardado');
  });
});

describe('cerrar pestañas', () => {
  it('con cambios pregunta; "no guardar" cierra sin escribir y pasa a la vecina', async () => {
    const f = falso({ 'a.tex': { text: 'a' }, 'b.tex': { text: 'b' }, 'c.tex': { text: 'c' } });
    for (const r of ['a.tex', 'b.tex', 'c.tex']) await st().abrirArchivo(r);
    st().activar('b.tex');
    editarDoc('b.tex', { from: 0, insert: 'X' });
    const cerrando = st().cerrarTab('b.tex');
    await responder('descartar');
    await cerrando;
    expect(st().tabs.map((t) => t.rel)).toEqual(['a.tex', 'c.tex']);
    expect(st().activeRel).toBe('c.tex');
    expect(f.llamadas).not.toContain('write b.tex');
  });

  it('cancelar la pregunta deja todo como estaba; guardar escribe y cierra', async () => {
    const f = falso({ 'a.tex': { text: 'a' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    const c1 = st().cerrarTab('a.tex');
    await responder('cancelar');
    await c1;
    expect(st().tabs).toHaveLength(1);
    const c2 = st().cerrarTab('a.tex');
    await responder('guardar');
    await c2;
    expect(st().tabs).toHaveLength(0);
    expect(st().activeRel).toBeNull();
    expect(f.disco.get('a.tex')!.text).toBe('Xa');
  });
});

describe('compilar', () => {
  it('guarda todo ANTES de lanzar el build', async () => {
    const f = falso({ 'a.tex': { text: 'a' }, 'b.tex': { text: 'b' } });
    await st().abrirArchivo('a.tex');
    await st().abrirArchivo('b.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    editarDoc('b.tex', { from: 0, insert: 'Y' });
    await st().compilar();
    expect(f.llamadas.filter((l) => /^(write|build)/.test(l))).toEqual(['write a.tex', 'write b.tex', 'build']);
    expect(st().build.status).toBe('running');
  });

  it('sin raíz o sin proyecto no compila y avisa', async () => {
    const f = falso({});
    useApp.setState({ rootFile: null });
    await st().compilar();
    expect(f.llamadas).not.toContain('build');
    expect(st().notice?.texto).toContain('raíz');
  });

  it('si guardar se cancela, no compila', async () => {
    const f = falso({ 'a.tex': { text: 'a', version: 'v0' } });
    await st().abrirArchivo('a.tex');
    f.disco.get('a.tex')!.version = 'v9';
    editarDoc('a.tex', { from: 0, insert: 'X' });
    const c = st().compilar();
    await responder('cancelar');
    await c;
    expect(f.llamadas).not.toContain('build');
    expect(st().build.status).toBe('idle');
  });

  it('si el backend rechaza el build (ocupado), la barra vuelve a idle y se avisa', async () => {
    const f = falso({});
    const b = (await import('../backend')).getBackend();
    b.build = async () => {
      throw new BackendError('busy', 'ya hay una compilación en curso');
    };
    await st().compilar();
    expect(f.llamadas).not.toContain('build');
    expect(st().build.status).toBe('idle');
    expect(st().notice?.nivel).toBe('error');
  });
});

describe('eventos del build', () => {
  const inicio = (id = 1): BuildEvent => ({ type: 'started', id, perfil: 'completo', cmdline: 'latexmk -pdf x' });
  const fin = (o: Partial<Extract<BuildEvent, { type: 'finished' }>> = {}): BuildEvent => ({
    type: 'finished', id: 1, ok: true, code: 0, cancelled: false, ms: 1500, pdf: '.lv/build/completo/lv-completo.pdf', updated: true, ...o,
  });

  it('started limpia el log y pone la línea de comandos; log agrega texto', () => {
    logBuffer.append('de antes\n');
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild({ type: 'log', id: 1, text: 'hola\n[1] ' });
    st().manejarEventoBuild({ type: 'log', id: 1, text: '[2]' });
    expect(logBuffer.slice(0, logBuffer.length)).toEqual(['$ latexmk -pdf x', 'hola', '[1] [2]']);
    expect(st().build).toMatchObject({ status: 'running', id: 1 });
  });

  it('un build bueno con PDF actualizado recarga el visor', () => {
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild(fin());
    expect(st().build).toMatchObject({ status: 'ok', ms: 1500, code: 0 });
    expect(st().pdfRel).toBe('.lv/build/completo/lv-completo.pdf');
    expect(st().pdfEpoch).toBe(1);
  });

  it('un build sin cambios no recarga el visor si ya muestra ese PDF, pero sí si todavía no hay ninguno', () => {
    st().manejarEventoBuild(fin({ updated: false })); // todavía no había PDF en el visor
    expect(st().pdfEpoch).toBe(1);
    st().manejarEventoBuild(fin({ updated: false }));
    expect(st().pdfEpoch).toBe(1);
    st().manejarEventoBuild(fin({ updated: true }));
    expect(st().pdfEpoch).toBe(2);
  });

  it('un build que falla no toca el visor aunque haya un PDF', () => {
    st().manejarEventoBuild(fin({ ok: false, code: 12 }));
    expect(st().build).toMatchObject({ status: 'fail', code: 12 });
    expect(st().pdfRel).toBeNull();
    expect(st().pdfEpoch).toBe(0);
    expect(logBuffer.slice(0, logBuffer.length).join('\n')).toContain('falló (código 12)');
  });

  it('cancelado queda como cancelado', () => {
    st().manejarEventoBuild(fin({ ok: false, cancelled: true, code: 1, pdf: null }));
    expect(st().build.status).toBe('cancelled');
  });
});

describe('cierre de la ventana y cambio de proyecto', () => {
  it('sin cambios se puede cerrar sin preguntar', async () => {
    falso({ 'a.tex': { text: 'a' } });
    await st().abrirArchivo('a.tex');
    expect(await st().permitirCierre()).toBe(true);
    expect(st().dialog).toBeNull();
  });

  it('con cambios: descartar cierra, cancelar no, guardar escribe y cierra', async () => {
    const f = falso({ 'a.tex': { text: 'a' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    let p = st().permitirCierre();
    await responder('cancelar');
    expect(await p).toBe(false);
    p = st().permitirCierre();
    await responder('descartar');
    expect(await p).toBe(true);
    expect(f.llamadas).not.toContain('write a.tex');
    p = st().permitirCierre();
    await responder('guardar');
    expect(await p).toBe(true);
    expect(f.disco.get('a.tex')!.text).toBe('Xa');
  });

  it('abrir otro proyecto con cambios sin guardar pregunta antes y cerrarlo todo', async () => {
    falso({ 'a.tex': { text: 'a' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    const p = st().abrirProyecto('/otro');
    await responder('cancelar');
    await p;
    expect(st().tabs).toHaveLength(1); // se canceló: sigue todo
    const q = st().abrirProyecto('/otro');
    await responder('descartar');
    await q;
    expect(st().tabs).toHaveLength(0);
    expect(getDoc('a.tex')).toBeUndefined();
  });

  it('con una sola candidata la toma; con varias y ninguna sugerida pregunta cuál', async () => {
    const f = falso({}, { candidates: ['cap_actual.tex', 'libro_fast.tex'], suggested: null });
    const p = st().abrirProyecto('/libro');
    await responder('libro_fast.tex');
    await p;
    expect(st().rootFile).toBe('libro_fast.tex');
    expect(f.llamadas).toContain('raiz libro_fast.tex');
    // "Ninguno por ahora" deja la raíz sin elegir.
    const q = st().abrirProyecto('/libro');
    await responder('');
    await q;
    expect(st().rootFile).toBeNull();
  });

  it('la raíz que viene de afuera (LV_ROOT) no pregunta nada', async () => {
    const f = falso({}, { candidates: ['a.tex', 'b.tex'], suggested: null });
    await st().abrirProyecto('/libro', 'b.tex');
    expect(st().dialog).toBeNull();
    expect(st().rootFile).toBe('b.tex');
    expect(f.llamadas).toContain('raiz b.tex');
  });
});
