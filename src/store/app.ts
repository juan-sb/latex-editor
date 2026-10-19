// Estado de la aplicación. El store guarda sólo METADATOS: el texto de cada documento vive en su `EditorState`
// (`editor/docs.ts`), que es la única copia, y el log del build en `logbuffer.ts`. Toda la E/S pasa por el `Backend`.
import { create } from 'zustand';
import { BackendError, getBackend, type BuildEvent, type Eol, type LaunchOptions, type ProjectInfo } from '../backend';
import {
  cerrarDoc,
  cerrarTodos,
  crearDoc,
  estaModificado,
  getDoc,
  hacerEditable,
  marcarGuardado,
  setDirtyListener,
} from '../editor/docs';
import { logBuffer } from './logbuffer';

export interface TabMeta {
  rel: string;
  name: string;
  dirty: boolean;
  readOnly: boolean;
  mixed: boolean;
  eol: Eol;
  bom: boolean;
  /** Cambia cuando hay que volver a poner el estado en la vista (por ejemplo, al pasar a editable). */
  epoch: number;
}

export type BuildStatus = 'idle' | 'running' | 'ok' | 'fail' | 'cancelled';

export interface BuildState {
  status: BuildStatus;
  id: number | null;
  ms: number | null;
  code: number | null;
  cmdline: string | null;
}

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DialogState {
  mensaje: string;
  detalle?: string;
  botones: DialogButton[];
  resolver: (id: string) => void;
}

export interface Notice {
  texto: string;
  nivel: 'info' | 'error';
}

export type ResultadoGuardado = 'guardado' | 'sin-cambios' | 'cancelado' | 'error';

interface AppState {
  project: ProjectInfo | null;
  rootFile: string | null;
  tabs: TabMeta[];
  activeRel: string | null;
  build: BuildState;
  /** El PDF que muestra el visor, y un contador que sube cada vez que hay que recargarlo. */
  pdfRel: string | null;
  pdfEpoch: number;
  notice: Notice | null;
  dialog: DialogState | null;

  init(): Promise<LaunchOptions>;
  abrirCarpeta(): Promise<void>;
  abrirProyecto(path: string, raizInicial?: string | null): Promise<void>;
  elegirRaiz(rel: string): Promise<void>;
  abrirArchivo(rel: string): Promise<void>;
  activar(rel: string): void;
  cerrarTab(rel: string): Promise<void>;
  guardar(rel?: string, opciones?: { forzar?: boolean }): Promise<ResultadoGuardado>;
  guardarTodo(): Promise<boolean>;
  hacerEditable(rel: string): void;
  compilar(): Promise<void>;
  cancelarBuild(): Promise<void>;
  manejarEventoBuild(e: BuildEvent): void;
  permitirCierre(): Promise<boolean>;
  preguntar(mensaje: string, botones: DialogButton[], detalle?: string): Promise<string>;
  responderDialogo(id: string): void;
  avisar(texto: string, nivel?: 'info' | 'error'): void;
  cerrarAviso(): void;
}

const nombreDe = (rel: string) => rel.split('/').pop() ?? rel;
const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BUILD_INICIAL: BuildState = { status: 'idle', id: null, ms: null, code: null, cmdline: null };

let inicializado = false;
/** Las preguntas se encolan: dos diálogos a la vez se pisarían. */
let colaDePreguntas: Promise<unknown> = Promise.resolve();

export const useApp = create<AppState>()((set, get) => {
  const actualizarTab = (rel: string, cambios: Partial<TabMeta>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.rel === rel ? { ...t, ...cambios } : t)) }));

  // El registro de documentos avisa cuando una pestaña pasa de limpia a modificada o al revés.
  setDirtyListener((rel, dirty) => actualizarTab(rel, { dirty }));

  return {
    project: null,
    rootFile: null,
    tabs: [],
    activeRel: null,
    build: BUILD_INICIAL,
    pdfRel: null,
    pdfEpoch: 0,
    notice: null,
    dialog: null,

    async init() {
      const b = getBackend();
      const opts = await b.launchOptions();
      if (!inicializado) {
        inicializado = true;
        await b.onBuildEvent((e) => get().manejarEventoBuild(e));
        await b.onCloseRequested(() => get().permitirCierre());
      }
      if (opts.open) {
        try {
          await get().abrirProyecto(opts.open, opts.root);
        } catch (e) {
          get().avisar(`No se pudo abrir ${opts.open}: ${mensajeDe(e)}`, 'error');
        }
      }
      return opts;
    },

    async abrirCarpeta() {
      const path = await getBackend().pickFolder();
      if (path) await get().abrirProyecto(path);
    },

    async abrirProyecto(path, raizInicial) {
      if (get().tabs.some((t) => t.dirty)) {
        const r = await get().preguntar('Hay archivos sin guardar.', [
          { id: 'guardar', label: 'Guardar todo y abrir', primary: true },
          { id: 'descartar', label: 'Descartar y abrir' },
          { id: 'cancelar', label: 'Cancelar' },
        ]);
        if (r === 'cancelar') return;
        if (r === 'guardar' && !(await get().guardarTodo())) return;
      }
      const info = await getBackend().openProject(path);
      cerrarTodos();
      set({ project: info, rootFile: null, tabs: [], activeRel: null, build: BUILD_INICIAL, pdfRel: null, notice: null });
      logBuffer.clear();
      if (raizInicial) {
        await get().elegirRaiz(raizInicial);
      } else if (info.suggested) {
        set({ rootFile: info.suggested });
      } else if (info.candidates.length > 0) {
        // Como el libro: varias raíces y el \begin{document} en otro archivo. No se puede decidir sola.
        const r = await get().preguntar('¿Cuál es el archivo raíz del documento?', [
          ...info.candidates.map((c) => ({ id: c, label: c })),
          { id: '', label: 'Ninguno por ahora' },
        ]);
        if (r) await get().elegirRaiz(r);
      } else {
        get().avisar('No encontré ningún .tex con \\documentclass. Abrí uno y usá "Usar como raíz".');
      }
    },

    async elegirRaiz(rel) {
      await getBackend().setRootFile(rel);
      set({ rootFile: rel });
    },

    async abrirArchivo(rel) {
      if (getDoc(rel)) {
        set({ activeRel: rel });
        return;
      }
      try {
        const r = await getBackend().readFile(rel);
        const e = crearDoc(rel, r);
        const tab: TabMeta = { rel, name: nombreDe(rel), dirty: false, readOnly: e.readOnly, mixed: e.mixed, eol: e.eol, bom: e.bom, epoch: 0 };
        set((s) => ({ tabs: [...s.tabs, tab], activeRel: rel }));
        if (r.mixed) get().avisar(`${nombreDe(rel)} mezcla tipos de salto de línea: se abre en sólo lectura.`);
      } catch (e) {
        get().avisar(`No se pudo abrir ${rel}: ${mensajeDe(e)}`, 'error');
      }
    },

    activar(rel) {
      if (getDoc(rel)) set({ activeRel: rel });
    },

    async cerrarTab(rel) {
      const e = getDoc(rel);
      if (e && estaModificado(e)) {
        const r = await get().preguntar(`"${nombreDe(rel)}" tiene cambios sin guardar.`, [
          { id: 'guardar', label: 'Guardar', primary: true },
          { id: 'descartar', label: 'No guardar' },
          { id: 'cancelar', label: 'Cancelar' },
        ]);
        if (r === 'cancelar') return;
        if (r === 'guardar') {
          const g = await get().guardar(rel);
          if (g === 'cancelado' || g === 'error') return;
        }
      }
      cerrarDoc(rel);
      set((s) => {
        const tabs = s.tabs.filter((t) => t.rel !== rel);
        let activeRel = s.activeRel;
        if (activeRel === rel) {
          const i = s.tabs.findIndex((t) => t.rel === rel);
          activeRel = tabs.length ? tabs[Math.min(i, tabs.length - 1)].rel : null;
        }
        return { tabs, activeRel };
      });
    },

    async guardar(relPedida, opciones) {
      const rel = relPedida ?? get().activeRel;
      const e = rel ? getDoc(rel) : undefined;
      if (!rel || !e) return 'error';
      if (e.readOnly) return 'sin-cambios';
      if (!estaModificado(e) && !opciones?.forzar) return 'sin-cambios';
      // El texto y el documento se toman ANTES del await: si el usuario sigue escribiendo mientras se guarda, la
      // pestaña tiene que seguir modificada (se compara contra lo que se escribió, no contra lo más nuevo).
      const doc = e.state.doc;
      const texto = doc.toString();
      let version: string | null = e.version;
      for (let intento = 0; intento < 2; intento++) {
        try {
          const r = await getBackend().writeFile(rel, texto, version);
          marcarGuardado(rel, doc, r.version);
          return r.written ? 'guardado' : 'sin-cambios';
        } catch (err) {
          if (err instanceof BackendError && err.kind === 'conflict' && intento === 0) {
            const resp = await get().preguntar(
              `"${nombreDe(rel)}" cambió en disco desde que lo abriste.`,
              [
                { id: 'sobrescribir', label: 'Sobrescribir con mi versión' },
                { id: 'cancelar', label: 'Cancelar', primary: true },
              ],
              'Si sobrescribís, se pierden los cambios que se hicieron afuera.',
            );
            if (resp !== 'sobrescribir') return 'cancelado';
            // Se vuelve a escribir con la versión que tiene el disco ahora; vacía = lo borraron, se recrea.
            version = err.diskVersion ? err.diskVersion : null;
            continue;
          }
          get().avisar(`No se pudo guardar ${nombreDe(rel)}: ${mensajeDe(err)}`, 'error');
          return 'error';
        }
      }
      return 'error';
    },

    async guardarTodo() {
      for (const t of get().tabs) {
        const e = getDoc(t.rel);
        if (e && estaModificado(e) && !e.readOnly) {
          const r = await get().guardar(t.rel);
          if (r === 'cancelado' || r === 'error') return false;
        }
      }
      return true;
    },

    hacerEditable(rel) {
      hacerEditable(rel);
      const e = getDoc(rel);
      if (e) actualizarTab(rel, { readOnly: false, epoch: (get().tabs.find((t) => t.rel === rel)?.epoch ?? 0) + 1 });
    },

    async compilar() {
      const s = get();
      if (s.build.status === 'running') return;
      if (!s.project) return s.avisar('Abrí una carpeta primero.');
      if (!s.rootFile) return s.avisar('Elegí la raíz del documento antes de compilar.');
      // Guardar todo y compilar (Ctrl+Enter): compilar con el disco viejo daría un PDF que no es lo que se ve.
      if (!(await get().guardarTodo())) return;
      set((x) => ({ build: { ...x.build, status: 'running', ms: null, code: null } }));
      try {
        await getBackend().build();
      } catch (e) {
        set({ build: BUILD_INICIAL });
        get().avisar(mensajeDe(e), 'error');
      }
    },

    async cancelarBuild() {
      await getBackend().cancelBuild();
    },

    manejarEventoBuild(e) {
      if (e.type === 'started') {
        logBuffer.clear();
        logBuffer.append(`$ ${e.cmdline}\n`);
        set({ build: { status: 'running', id: e.id, ms: null, code: null, cmdline: e.cmdline } });
      } else if (e.type === 'log') {
        logBuffer.append(e.text);
      } else {
        const status: BuildStatus = e.cancelled ? 'cancelled' : e.ok ? 'ok' : 'fail';
        set((s) => ({
          build: { ...s.build, status, id: e.id, ms: e.ms, code: e.code },
          // Sólo se recarga el visor con un build bueno y, si no hubo cambios, sólo cuando todavía no hay PDF.
          ...(e.ok && e.pdf && (e.updated || s.pdfRel !== e.pdf) ? { pdfRel: e.pdf, pdfEpoch: s.pdfEpoch + 1 } : {}),
        }));
        logBuffer.append(`\n== ${status === 'ok' ? 'terminó bien' : status === 'cancelled' ? 'cancelado' : `falló (código ${e.code ?? '?'})`} en ${(e.ms / 1000).toFixed(1)} s\n`);
      }
    },

    async permitirCierre() {
      const n = get().tabs.filter((t) => t.dirty).length;
      if (n === 0) return true;
      const r = await get().preguntar(`Hay ${n} archivo${n > 1 ? 's' : ''} sin guardar.`, [
        { id: 'guardar', label: 'Guardar todo y cerrar', primary: true },
        { id: 'descartar', label: 'Cerrar sin guardar' },
        { id: 'cancelar', label: 'Cancelar' },
      ]);
      if (r === 'guardar') return get().guardarTodo();
      return r === 'descartar';
    },

    preguntar(mensaje, botones, detalle) {
      const pregunta = colaDePreguntas.then(
        () =>
          new Promise<string>((resolver) => {
            set({ dialog: { mensaje, detalle, botones, resolver } });
          }),
      );
      colaDePreguntas = pregunta.catch(() => undefined);
      return pregunta;
    },

    responderDialogo(id) {
      const d = get().dialog;
      if (!d) return;
      set({ dialog: null });
      d.resolver(id);
    },

    avisar(texto, nivel = 'info') {
      set({ notice: { texto, nivel } });
    },

    cerrarAviso() {
      set({ notice: null });
    },
  };
});
