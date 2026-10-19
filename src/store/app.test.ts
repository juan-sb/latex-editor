import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackendError,
  setBackend,
  type AppStateInfo,
  type Backend,
  type BuildAck,
  type BuildEvent,
  type Eol,
  type FileInfo,
  type ProfileInfo,
  type ProjectInfo,
  type StatePatch,
} from '../backend';
import { cerrarTodos, editarDoc, getDoc } from '../editor/docs';
import { BUILD_INICIAL, useApp } from './app';
import { logBuffer } from './logbuffer';

interface Archivo {
  text: string;
  version: string;
  eol: Eol;
  bom: boolean;
  mixed: boolean;
}

const perfil = (id: string, o: Partial<ProfileInfo> = {}): ProfileInfo => ({
  id,
  label: id,
  partial: false,
  externalize: false,
  parts: 'all',
  cleanBefore: false,
  autoCompile: true,
  hidden: false,
  ...o,
});

/** El estado de esta máquina de los tests: manual, para que guardar no dispare builds salvo en los tests que lo piden. */
const estadoBase = (): AppStateInfo => ({
  root: null,
  activeProfile: 'parcial',
  selection: ['Secciones/Uno'],
  variables: {},
  autoCompile: 'manual',
  idleMs: 500,
  outsideSave: 'warn',
});

function infoDe(o: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: 'p',
    root: '/p',
    candidates: ['main.tex'],
    rootFile: 'main.tex',
    configSaved: true,
    configError: null,
    config: {
      engine: 'pdflatex',
      profiles: [perfil('parcial', { partial: true, parts: 'selection' }), perfil('rapido', { partial: true }), perfil('completo', { autoCompile: false })],
      variables: [{ name: 'OpcionPie', label: 'Pie', choices: ['completo', 'autor'], default: 'completo' }],
      publishDir: '../PDF',
    },
    state: estadoBase(),
    parts: [
      { name: 'Secciones/Uno', file: 'Secciones/Uno.tex', command: 'include' },
      { name: 'Secciones/Dos', file: 'Secciones/Dos.tex', command: 'include' },
      { name: 'Secciones/Tres', file: 'Secciones/Tres.tex', command: 'include' },
    ],
    indexMs: 3,
    ...o,
  };
}

/** Un backend en memoria que registra qué se le pidió y en qué orden. */
function falso(archivos: Record<string, Partial<Archivo> & { text: string }>, proyecto?: Partial<ProjectInfo>) {
  const llamadas: string[] = [];
  const disco = new Map<string, Archivo>(
    Object.entries(archivos).map(([k, v]) => [k, { version: 'v0', eol: 'lf', bom: false, mixed: false, ...v }]),
  );
  let n = 1;
  const estado = { ...estadoBase(), ...proyecto?.state };
  const control = {
    demoraEscritura: null as Promise<void> | null,
    fileInfo: ((): FileInfo => ({ part: null, affects: 'yes', profileAuto: true, partsChanged: false })) as (rel: string) => FileInfo,
    ack: { kind: 'started', id: 1 } as BuildAck,
  };
  const vista = (o: Partial<ProjectInfo> = {}) => infoDe({ ...proyecto, state: { ...estado }, ...o });
  const b: Backend = {
    launchOptions: async () => ({ open: null, root: null, smoke: false, smokeMode: 'f1', smokeFile: null, smokePausaMs: 0 }),
    pickFolder: async () => '/p',
    openProject: async () => vista(),
    getProject: async () => {
      llamadas.push('getProject');
      return vista();
    },
    setRootFile: async (rel) => {
      llamadas.push(`raiz ${rel}`);
      return vista({ rootFile: rel });
    },
    setState: async (patch: StatePatch) => {
      llamadas.push(`estado ${JSON.stringify(patch)}`);
      Object.assign(estado, patch);
      return { ...estado };
    },
    saveConfig: async () => {
      llamadas.push('saveConfig');
      return vista({ configSaved: true });
    },
    fileInfo: async (rel) => {
      llamadas.push(`info ${rel}`);
      return control.fileInfo(rel);
    },
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
    build: async (p) => {
      llamadas.push(p ? `build ${p}` : 'build');
      return control.ack;
    },
    cancelBuild: async () => {
      llamadas.push('cancel');
      return true;
    },
    publish: async (p) => {
      llamadas.push(`publish ${p}`);
      return { pdf: `C:/pub/${p}.pdf`, synctex: null };
    },
    onBuildEvent: async () => () => {},
    onCloseRequested: async () => () => {},
    exitApp: async () => {},
    smokeReadBytes: async () => new Uint8Array(),
    smokeMtime: async () => 0,
    writeSmokeResult: async () => {},
  };
  setBackend(b);
  return { llamadas, disco, control, estado };
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
    project: infoDe(),
    rootFile: 'main.tex',
    tabs: [],
    activeRel: null,
    build: BUILD_INICIAL,
    pdfRel: null,
    pdfEpoch: 0,
    pdfStale: false,
    panelIzq: 'archivos',
    parteActiva: null,
    notice: null,
    dialog: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
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

  it('con la auto-compilación al guardar, compilar no pide dos builds (guarda sin disparar la suya)', async () => {
    const f = falso({ 'a.tex': { text: 'a' } }, { state: { ...estadoBase(), autoCompile: 'save' } });
    useApp.setState({ project: infoDe({ state: { ...estadoBase(), autoCompile: 'save' } }) });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    await st().compilar();
    await new Promise((r) => setTimeout(r, 60));
    expect(f.llamadas.filter((l) => l.startsWith('build'))).toHaveLength(1);
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

  it('si el backend rechaza el build, la barra vuelve a idle y se avisa', async () => {
    const f = falso({});
    const b = (await import('../backend')).getBackend();
    b.build = async () => {
      throw new BackendError('other', 'elegí al menos una parte para compilar');
    };
    await st().compilar();
    expect(f.llamadas).not.toContain('build');
    expect(st().build.status).toBe('idle');
    expect(st().notice?.nivel).toBe('error');
  });

  it('un pedido mientras corre otro queda pendiente y no cambia el estado de la barra', async () => {
    const f = falso({});
    f.control.ack = { kind: 'queued' };
    st().manejarEventoBuild({ type: 'started', id: 1, perfil: 'parcial', cmdline: 'latexmk', retry: false });
    await st().compilar('rapido');
    expect(f.llamadas).toContain('build rapido');
    expect(st().build).toMatchObject({ status: 'running', pendiente: 'rapido' });
  });

  it('cancelar descarta el pendiente en la barra y le avisa al core', async () => {
    const f = falso({});
    st().manejarEventoBuild({ type: 'started', id: 1, perfil: 'parcial', cmdline: 'latexmk', retry: false });
    st().manejarEventoBuild({ type: 'queued', perfil: 'rapido' });
    expect(st().build.pendiente).toBe('rapido');
    await st().cancelarBuild();
    expect(st().build.pendiente).toBeNull();
    expect(f.llamadas).toContain('cancel');
  });
});

describe('eventos del build', () => {
  const inicio = (id = 1, retry = false): BuildEvent => ({ type: 'started', id, perfil: 'completo', cmdline: 'latexmk -pdf x', retry });
  const fin = (o: Partial<Extract<BuildEvent, { type: 'finished' }>> = {}): BuildEvent => ({
    type: 'finished',
    id: 1,
    perfil: 'completo',
    ok: true,
    code: 0,
    cancelled: false,
    ms: 1500,
    pdf: '.lv/build/completo/lv-completo.pdf',
    updated: true,
    passes: 2,
    truncated_aux: false,
    repaired: false,
    ...o,
  });

  it('started limpia el log y pone la línea de comandos; log agrega texto', () => {
    logBuffer.append('de antes\n');
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild({ type: 'log', id: 1, text: 'hola\n[1] ' });
    st().manejarEventoBuild({ type: 'log', id: 1, text: '[2]' });
    expect(logBuffer.slice(0, logBuffer.length)).toEqual(['$ latexmk -pdf x', 'hola', '[1] [2]']);
    expect(st().build).toMatchObject({ status: 'running', id: 1, perfil: 'completo' });
  });

  it('el reintento después de reparar un .aux sigue en el mismo log', () => {
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild({ type: 'log', id: 1, text: '! File ended while scanning use of \\@newl@bel.\n' });
    st().manejarEventoBuild(inicio(2, true));
    const log = logBuffer.slice(0, logBuffer.length).join('\n');
    expect(log).toContain('File ended while scanning');
    expect(log.match(/\$ latexmk -pdf x/g)).toHaveLength(2);
    expect(st().build.repaired).toBe(true);
    st().manejarEventoBuild(fin({ repaired: true }));
    expect(logBuffer.slice(0, logBuffer.length).join('\n')).toContain('después de reparar los auxiliares');
  });

  it('un build bueno con PDF actualizado recarga el visor y muestra las pasadas', () => {
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild(fin());
    expect(st().build).toMatchObject({ status: 'ok', ms: 1500, code: 0, passes: 2 });
    expect(st().pdfRel).toBe('.lv/build/completo/lv-completo.pdf');
    expect(st().pdfEpoch).toBe(1);
    expect(st().pdfStale).toBe(false);
    expect(logBuffer.slice(0, logBuffer.length).join('\n')).toContain('terminó bien en 1.5 s, 2 pasadas');
  });

  it('un build sin cambios no recarga el visor si ya muestra ese PDF, pero sí si todavía no hay ninguno', () => {
    st().manejarEventoBuild(fin({ updated: false })); // todavía no había PDF en el visor
    expect(st().pdfEpoch).toBe(1);
    st().manejarEventoBuild(fin({ updated: false }));
    expect(st().pdfEpoch).toBe(1);
    st().manejarEventoBuild(fin({ updated: true }));
    expect(st().pdfEpoch).toBe(2);
  });

  it('un build que falla no toca el visor; si hay un PDF, queda marcado como desactualizado hasta el próximo bueno', () => {
    st().manejarEventoBuild(fin({ ok: false, code: 12 }));
    expect(st().build).toMatchObject({ status: 'fail', code: 12 });
    expect(st().pdfRel).toBeNull();
    expect(st().pdfEpoch).toBe(0);
    expect(st().pdfStale).toBe(false); // no hay PDF que marcar
    expect(logBuffer.slice(0, logBuffer.length).join('\n')).toContain('falló (código 12)');
    st().manejarEventoBuild(fin());
    expect(st().pdfStale).toBe(false);
    st().manejarEventoBuild(fin({ ok: false, code: 12 }));
    expect(st().pdfRel).toBe('.lv/build/completo/lv-completo.pdf');
    expect(st().pdfEpoch).toBe(1);
    expect(st().pdfStale).toBe(true);
    st().manejarEventoBuild(fin({ updated: true }));
    expect(st().pdfStale).toBe(false);
    expect(st().pdfEpoch).toBe(2);
  });

  it('cancelado queda como cancelado y también marca el PDF como desactualizado', () => {
    st().manejarEventoBuild(fin());
    st().manejarEventoBuild(fin({ ok: false, cancelled: true, code: 1, pdf: null }));
    expect(st().build.status).toBe('cancelled');
    expect(st().pdfStale).toBe(true);
  });

  it('queued marca el pendiente, started lo limpia y un error del core se avisa', () => {
    st().manejarEventoBuild(inicio());
    st().manejarEventoBuild({ type: 'queued', perfil: 'rapido' });
    expect(st().build.pendiente).toBe('rapido');
    st().manejarEventoBuild(fin());
    expect(st().build.pendiente).toBe('rapido'); // sigue hasta que arranque el pendiente
    st().manejarEventoBuild(inicio(2));
    expect(st().build.pendiente).toBeNull();
    st().manejarEventoBuild({ type: 'queued', perfil: 'rapido' });
    st().manejarEventoBuild({ type: 'error', message: 'no se pudo lanzar el build pendiente' });
    expect(st().build.pendiente).toBeNull();
    expect(st().notice).toMatchObject({ nivel: 'error', texto: 'no se pudo lanzar el build pendiente' });
  });
});

describe('perfiles y partes', () => {
  it('elegir perfil y variable van al core y se reflejan', async () => {
    const f = falso({});
    await st().elegirPerfil('rapido');
    expect(st().project!.state.activeProfile).toBe('rapido');
    await st().setVariable('OpcionPie', 'autor');
    expect(st().project!.state.variables).toEqual({ OpcionPie: 'autor' });
    expect(f.llamadas.filter((l) => l.startsWith('estado'))).toHaveLength(2);
  });

  it('alternar parte la agrega en el orden del documento, no deja la selección vacía y "todas" las tilda', async () => {
    falso({});
    await st().alternarParte('Secciones/Tres');
    await st().alternarParte('Secciones/Dos');
    expect(st().project!.state.selection).toEqual(['Secciones/Uno', 'Secciones/Dos', 'Secciones/Tres']);
    await st().alternarParte('Secciones/Uno');
    await st().alternarParte('Secciones/Dos');
    expect(st().project!.state.selection).toEqual(['Secciones/Tres']);
    await st().alternarParte('Secciones/Tres'); // la última no se destilda
    expect(st().project!.state.selection).toEqual(['Secciones/Tres']);
    await st().soloParte('Secciones/Dos');
    expect(st().project!.state.selection).toEqual(['Secciones/Dos']);
    await st().todasLasPartes();
    expect(st().project!.state.selection).toHaveLength(3);
  });

  it('un error del core al cambiar el estado se avisa y no cambia nada', async () => {
    falso({});
    const b = (await import('../backend')).getBackend();
    b.setState = async () => {
      throw new BackendError('other', 'no existe el perfil "x"');
    };
    await st().elegirPerfil('x');
    expect(st().project!.state.activeProfile).toBe('parcial');
    expect(st().notice?.nivel).toBe('error');
  });

  it('compilar una parte deja sólo esa parte, usa un perfil de partes elegidas y compila sin volver a guardar', async () => {
    const f = falso({ 'a.tex': { text: 'a' } });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    st().project!.state.activeProfile = 'completo';
    await st().compilarParte('Secciones/Dos', { guardar: false });
    expect(f.estado.selection).toEqual(['Secciones/Dos']);
    expect(f.estado.activeProfile).toBe('parcial');
    expect(f.llamadas).toContain('build parcial');
    expect(f.llamadas).not.toContain('write a.tex');
  });

  it('compilar la parte del archivo abierto usa lo que dice el core; sin parte, avisa', async () => {
    const f = falso({ 'Secciones/Dos.tex': { text: 'dos' }, 'suelto.tex': { text: 'x' } });
    f.control.fileInfo = (rel) => ({ part: rel.startsWith('Secciones/') ? 'Secciones/Dos' : null, affects: 'yes', profileAuto: true, partsChanged: false });
    await st().abrirArchivo('suelto.tex');
    await st().compilarParteActiva();
    expect(st().notice?.texto).toContain('no pertenece a ninguna parte');
    expect(f.llamadas.filter((l) => l.startsWith('build'))).toHaveLength(0);
    await st().abrirArchivo('Secciones/Dos.tex');
    await st().compilarParteActiva();
    expect(f.estado.selection).toEqual(['Secciones/Dos']);
    expect(f.llamadas).toContain('build parcial');
  });

  it('la parte del archivo activo se actualiza al cambiar de pestaña', async () => {
    const f = falso({ 'Secciones/Uno.tex': { text: 'u' }, 'main.tex': { text: 'm' } });
    f.control.fileInfo = (rel) => ({ part: rel.startsWith('Secciones/') ? 'Secciones/Uno' : null, affects: 'yes', profileAuto: true, partsChanged: false });
    await st().abrirArchivo('Secciones/Uno.tex');
    await vi.waitFor(() => expect(st().parteActiva).toBe('Secciones/Uno'));
    await st().abrirArchivo('main.tex');
    await vi.waitFor(() => expect(st().parteActiva).toBeNull());
    st().activar('Secciones/Uno.tex');
    await vi.waitFor(() => expect(st().parteActiva).toBe('Secciones/Uno'));
  });

  it('publicar usa el perfil del último build y avisa dónde quedó; guardar la configuración la deja como guardada', async () => {
    const f = falso({});
    st().manejarEventoBuild({ type: 'started', id: 1, perfil: 'rapido', cmdline: 'x', retry: false });
    await st().publicar();
    expect(f.llamadas).toContain('publish rapido');
    expect(st().notice?.texto).toBe('Publicado: C:/pub/rapido.pdf');
    useApp.setState({ project: infoDe({ configSaved: false }) });
    await st().guardarConfig();
    expect(f.llamadas).toContain('saveConfig');
    expect(st().project!.configSaved).toBe(true);
  });
});

describe('auto-compilación', () => {
  const conModo = (modo: AppStateInfo['autoCompile'], extra: Partial<AppStateInfo> = {}) => {
    const state = { ...estadoBase(), autoCompile: modo, ...extra };
    useApp.setState({ project: infoDe({ state }) });
    return state;
  };
  const con = (afecta: Partial<FileInfo>) => {
    const f = falso({ 'a.tex': { text: 'a' } });
    f.control.fileInfo = () => ({ part: null, affects: 'yes', profileAuto: true, partsChanged: false, ...afecta });
    return f;
  };
  const compilaron = (f: ReturnType<typeof falso>) => f.llamadas.filter((l) => l.startsWith('build'));

  it('Ctrl+S con el modo "al guardar" compila el perfil activo si el archivo lo afecta', async () => {
    conModo('save');
    const f = con({ affects: 'yes' });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    await st().guardar('a.tex');
    await vi.waitFor(() => expect(compilaron(f)).toEqual(['build']));
    expect(f.llamadas).toContain('info a.tex');
    expect(f.llamadas).not.toContain('getProject');
  });

  it('en modo manual, o si el perfil no compila al guardar, o si el archivo no está en el grafo, no compila', async () => {
    for (const caso of [
      { modo: 'manual' as const, info: { affects: 'yes' as const } },
      { modo: 'save' as const, info: { affects: 'yes' as const, profileAuto: false } },
      { modo: 'save' as const, info: { affects: 'unrelated' as const } },
    ]) {
      conModo(caso.modo);
      const f = con(caso.info);
      cerrarTodos();
      useApp.setState({ tabs: [], activeRel: null });
      await st().abrirArchivo('a.tex');
      editarDoc('a.tex', { from: 0, insert: 'X' });
      await st().guardar('a.tex');
      await vi.waitFor(() => expect(f.llamadas).toContain('info a.tex'));
      await new Promise((r) => setTimeout(r, 30));
      expect(compilaron(f), JSON.stringify(caso)).toHaveLength(0);
    }
  });

  it('guardar sin cambios no consulta ni compila', async () => {
    conModo('save');
    const f = con({});
    await st().abrirArchivo('a.tex');
    await new Promise((r) => setTimeout(r, 10));
    f.llamadas.length = 0; // abrir ya pregunta por la parte del archivo; lo que importa es lo que viene después
    expect(await st().guardar('a.tex', { forzar: true })).toBe('sin-cambios');
    await new Promise((r) => setTimeout(r, 30));
    expect(f.llamadas).not.toContain('info a.tex');
    expect(compilaron(f)).toHaveLength(0);
  });

  it('una parte nueva en el proyecto vuelve a leerlo', async () => {
    conModo('manual');
    const f = con({ partsChanged: true });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    await st().guardar('a.tex');
    await vi.waitFor(() => expect(f.llamadas).toContain('getProject'));
  });

  describe('archivo de una parte que el perfil activo no incluye', () => {
    const preparar = (outside: AppStateInfo['outsideSave']) => {
      conModo('save', { outsideSave: outside });
      return con({ affects: 'other_part', part: 'Secciones/Dos' });
    };
    const guardarA = async () => {
      await st().abrirArchivo('a.tex');
      editarDoc('a.tex', { from: 0, insert: 'X' });
      await st().guardar('a.tex');
    };

    it('avisar: ofrece "Compilar esta parte" y no compila hasta que se acepta', async () => {
      const f = preparar('warn');
      await guardarA();
      await vi.waitFor(() => expect(st().notice?.accion?.label).toBe('Compilar esta parte'));
      expect(st().notice?.texto).toContain('Dos');
      expect(compilaron(f)).toHaveLength(0);
      st().notice!.accion!.run();
      await vi.waitFor(() => expect(compilaron(f)).toEqual(['build parcial']));
      expect(f.estado.selection).toEqual(['Secciones/Dos']);
    });

    it('cambiar la selección: selecciona esa parte y compila', async () => {
      const f = preparar('switch');
      await guardarA();
      await vi.waitFor(() => expect(compilaron(f)).toEqual(['build parcial']));
      expect(f.estado.selection).toEqual(['Secciones/Dos']);
    });

    it('compilar igual: compila el perfil activo sin tocar la selección', async () => {
      const f = preparar('build');
      await guardarA();
      await vi.waitFor(() => expect(compilaron(f)).toEqual(['build']));
      expect(f.estado.selection).toEqual(['Secciones/Uno']);
    });
  });

  it('al dejar de tipear: guarda una vez pasado el tiempo, y cada tecla reinicia la cuenta', async () => {
    vi.useFakeTimers();
    conModo('idle', { idleMs: 500 });
    const f = con({ affects: 'yes' });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    st().alEditar('a.tex');
    await vi.advanceTimersByTimeAsync(400);
    editarDoc('a.tex', { from: 1, insert: 'Y' });
    st().alEditar('a.tex');
    await vi.advanceTimersByTimeAsync(400);
    expect(f.llamadas).not.toContain('write a.tex');
    await vi.advanceTimersByTimeAsync(200);
    expect(f.disco.get('a.tex')!.text).toBe('XYa');
    await vi.advanceTimersByTimeAsync(10);
    expect(compilaron(f)).toEqual(['build']);
  });

  it('el modo "al dejar de tipear" no hace nada si el modo es otro, y cambiar de modo cancela lo pendiente', async () => {
    vi.useFakeTimers();
    conModo('idle', { idleMs: 500 });
    const f = con({ affects: 'yes' });
    await st().abrirArchivo('a.tex');
    editarDoc('a.tex', { from: 0, insert: 'X' });
    st().alEditar('a.tex');
    await st().setAutoCompile('manual');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.llamadas).not.toContain('write a.tex');
    conModo('save');
    st().alEditar('a.tex');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.llamadas).not.toContain('write a.tex');
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
    const f = falso({}, { candidates: ['cap_actual.tex', 'libro_fast.tex'], rootFile: null });
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
    const f = falso({}, { candidates: ['a.tex', 'b.tex'], rootFile: null });
    await st().abrirProyecto('/libro', 'b.tex');
    expect(st().dialog).toBeNull();
    expect(st().rootFile).toBe('b.tex');
    expect(f.llamadas).toContain('raiz b.tex');
  });

  it('un latexviewer.json ilegible se avisa y un proyecto sin él ofrece guardarlo', async () => {
    falso({}, { configError: 'latexviewer.json: expected value at line 1', configSaved: false });
    await st().abrirProyecto('/libro');
    expect(st().notice?.nivel).toBe('error');
    expect(st().notice?.texto).toContain('latexviewer.json no se pudo leer');
    falso({}, { configSaved: false });
    await st().abrirProyecto('/libro');
    expect(st().notice?.texto).toContain('no tiene latexviewer.json');
  });
});
