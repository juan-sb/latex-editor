// Estado de la aplicación. El store guarda sólo METADATOS: el texto de cada documento vive en su `EditorState`
// (`editor/docs.ts`), que es la única copia, y el log del build en `logbuffer.ts`. Toda la E/S pasa por el `Backend`.
import { create } from 'zustand';
import {
  BackendError,
  getBackend,
  type AppStateInfo,
  type AutoCompileMode,
  type BuildEvent,
  type Eol,
  type FileInfo,
  type LaunchOptions,
  type OutsideSave,
  type ProfileInfo,
  type ProjectInfo,
  type StatePatch,
} from '../backend';
import {
  cerrarDoc,
  cerrarTodos,
  crearDoc,
  estaModificado,
  getDoc,
  hacerEditable,
  marcarGuardado,
  setDirtyListener,
  setEditListener,
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
  /** Perfil del build en curso o del último. */
  perfil: string | null;
  ms: number | null;
  code: number | null;
  cmdline: string | null;
  /** Pasadas que contó latexmk en el último build. */
  passes: number | null;
  /** El último build es el reintento después de reparar un `.aux` truncado. */
  repaired: boolean;
  /** Perfil que quedó en cola mientras corre otro build (corre una sola vez al terminar). */
  pendiente: string | null;
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
  /** Un botón en el aviso (por ejemplo, "Compilar esta parte"). */
  accion?: { label: string; run: () => void };
}

export type ResultadoGuardado = 'guardado' | 'sin-cambios' | 'cancelado' | 'error';
export type PanelIzquierdo = 'archivos' | 'partes';

interface AppState {
  project: ProjectInfo | null;
  rootFile: string | null;
  tabs: TabMeta[];
  activeRel: string | null;
  build: BuildState;
  /** El PDF que muestra el visor, y un contador que sube cada vez que hay que recargarlo. */
  pdfRel: string | null;
  pdfEpoch: number;
  /** El último build no terminó bien: el visor sigue mostrando el último PDF bueno. */
  pdfStale: boolean;
  panelIzq: PanelIzquierdo;
  /** La parte del archivo activo (para resaltarla en el panel de partes). */
  parteActiva: string | null;
  notice: Notice | null;
  dialog: DialogState | null;

  init(): Promise<LaunchOptions>;
  abrirCarpeta(): Promise<void>;
  abrirProyecto(path: string, raizInicial?: string | null): Promise<void>;
  refrescarProyecto(): Promise<void>;
  elegirRaiz(rel: string): Promise<void>;
  abrirArchivo(rel: string): Promise<void>;
  activar(rel: string): void;
  cerrarTab(rel: string): Promise<void>;
  guardar(rel?: string, opciones?: { forzar?: boolean; auto?: boolean }): Promise<ResultadoGuardado>;
  guardarTodo(opciones?: { auto?: boolean }): Promise<boolean>;
  hacerEditable(rel: string): void;
  compilar(perfil?: string, opciones?: { guardar?: boolean }): Promise<void>;
  cancelarBuild(): Promise<void>;
  manejarEventoBuild(e: BuildEvent): void;
  // perfiles, partes y auto-compilación
  elegirPerfil(id: string): Promise<void>;
  alternarParte(nombre: string): Promise<void>;
  soloParte(nombre: string): Promise<void>;
  todasLasPartes(): Promise<void>;
  compilarParte(nombre: string, opciones?: { guardar?: boolean }): Promise<void>;
  compilarParteActiva(): Promise<void>;
  setAutoCompile(modo: AutoCompileMode): Promise<void>;
  setOutsideSave(o: OutsideSave): Promise<void>;
  setVariable(nombre: string, valor: string): Promise<void>;
  publicar(): Promise<void>;
  guardarConfig(): Promise<void>;
  mostrarPanel(p: PanelIzquierdo): void;
  alEditar(rel: string): void;
  despuesDeGuardar(rel: string): Promise<void>;
  actualizarParteActiva(): Promise<void>;
  permitirCierre(): Promise<boolean>;
  preguntar(mensaje: string, botones: DialogButton[], detalle?: string): Promise<string>;
  responderDialogo(id: string): void;
  avisar(texto: string, nivel?: 'info' | 'error', accion?: Notice['accion']): void;
  cerrarAviso(): void;
}

const nombreDe = (rel: string) => rel.split('/').pop() ?? rel;
const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const BUILD_INICIAL: BuildState = {
  status: 'idle',
  id: null,
  perfil: null,
  ms: null,
  code: null,
  cmdline: null,
  passes: null,
  repaired: false,
  pendiente: null,
};

let inicializado = false;
/** Las preguntas se encolan: dos diálogos a la vez se pisarían. */
let colaDePreguntas: Promise<unknown> = Promise.resolve();
/** Autoguardado "al dejar de tipear": un solo temporizador para todo el proyecto. */
let temporizadorIdle: ReturnType<typeof setTimeout> | null = null;
let ultimoEditado: string | null = null;

export const perfilActivo = (p: ProjectInfo | null): ProfileInfo | undefined =>
  p?.config?.profiles.find((x) => x.id === p.state.activeProfile);

export const useApp = create<AppState>()((set, get) => {
  const actualizarTab = (rel: string, cambios: Partial<TabMeta>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.rel === rel ? { ...t, ...cambios } : t)) }));

  /** Aplica un cambio al estado de esta máquina (`.lv/state.json`) y refleja lo que quedó. */
  const aplicarEstado = async (patch: StatePatch): Promise<AppStateInfo | null> => {
    try {
      const st = await getBackend().setState(patch);
      set((s) => (s.project ? { project: { ...s.project, state: st } } : {}));
      return st;
    } catch (e) {
      get().avisar(mensajeDe(e), 'error');
      return null;
    }
  };

  const aplicarProyecto = (info: ProjectInfo) => set({ project: info, rootFile: info.rootFile });

  // El registro de documentos avisa cuando una pestaña pasa de limpia a modificada o al revés, y en cada edición.
  setDirtyListener((rel, dirty) => actualizarTab(rel, { dirty }));
  setEditListener((rel) => get().alEditar(rel));

  return {
    project: null,
    rootFile: null,
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
        if (r === 'guardar' && !(await get().guardarTodo({ auto: false }))) return;
      }
      const info = await getBackend().openProject(path);
      cerrarTodos();
      if (temporizadorIdle) clearTimeout(temporizadorIdle);
      temporizadorIdle = null;
      set({
        project: info,
        rootFile: info.rootFile,
        tabs: [],
        activeRel: null,
        build: BUILD_INICIAL,
        pdfRel: null,
        pdfStale: false,
        parteActiva: null,
        notice: null,
      });
      logBuffer.clear();
      if (info.configError) {
        get().avisar(`latexviewer.json no se pudo leer (${info.configError}). Se usa la configuración inferida y el archivo no se toca.`, 'error');
      }
      if (raizInicial) {
        await get().elegirRaiz(raizInicial);
      } else if (info.rootFile) {
        // ya hay raíz: la del proyecto, la de esta máquina o la única candidata
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
      // Si el archivo existe pero está roto ya se avisó (y es un aviso más importante que éste).
      if (get().project?.configSaved === false && !info.configError && get().rootFile) {
        get().avisar('Este proyecto no tiene latexviewer.json: se usa una configuración inferida. Podés guardarla desde el menú ⋯.');
      }
    },

    async refrescarProyecto() {
      try {
        aplicarProyecto(await getBackend().getProject());
      } catch (e) {
        get().avisar(`No se pudo releer el proyecto: ${mensajeDe(e)}`, 'error');
      }
    },

    async elegirRaiz(rel) {
      aplicarProyecto(await getBackend().setRootFile(rel));
    },

    async abrirArchivo(rel) {
      if (getDoc(rel)) {
        set({ activeRel: rel });
        void get().actualizarParteActiva();
        return;
      }
      try {
        const r = await getBackend().readFile(rel);
        const e = crearDoc(rel, r);
        const tab: TabMeta = { rel, name: nombreDe(rel), dirty: false, readOnly: e.readOnly, mixed: e.mixed, eol: e.eol, bom: e.bom, epoch: 0 };
        set((s) => ({ tabs: [...s.tabs, tab], activeRel: rel }));
        void get().actualizarParteActiva();
        if (r.mixed) get().avisar(`${nombreDe(rel)} mezcla tipos de salto de línea: se abre en sólo lectura.`);
      } catch (e) {
        get().avisar(`No se pudo abrir ${rel}: ${mensajeDe(e)}`, 'error');
      }
    },

    activar(rel) {
      if (getDoc(rel)) {
        set({ activeRel: rel });
        void get().actualizarParteActiva();
      }
    },

    async actualizarParteActiva() {
      const rel = get().activeRel;
      if (!rel || !get().project?.config) return set({ parteActiva: null });
      try {
        const info = await getBackend().fileInfo(rel);
        if (get().activeRel === rel) set({ parteActiva: info.part });
      } catch {
        set({ parteActiva: null });
      }
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
          // Guardar es lo que dispara la auto-compilación (5.3 del plan). Compilar guarda con `auto: false` para no
          // pedir dos builds.
          if (r.written && opciones?.auto !== false) void get().despuesDeGuardar(rel);
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

    async guardarTodo(opciones) {
      for (const t of get().tabs) {
        const e = getDoc(t.rel);
        if (e && estaModificado(e) && !e.readOnly) {
          const r = await get().guardar(t.rel, { auto: opciones?.auto });
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

    // --- auto-compilación -------------------------------------------------------------------------------------------

    alEditar(rel) {
      const p = get().project;
      if (!p || p.state.autoCompile !== 'idle') return;
      ultimoEditado = rel;
      if (temporizadorIdle) clearTimeout(temporizadorIdle);
      temporizadorIdle = setTimeout(() => {
        temporizadorIdle = null;
        void (async () => {
          // Todo lo modificado se guarda junto y el build se pide una sola vez, por el último archivo editado.
          for (const t of get().tabs) {
            if (t.rel !== ultimoEditado && t.dirty && !t.readOnly) await get().guardar(t.rel, { auto: false });
          }
          if (ultimoEditado) await get().guardar(ultimoEditado);
        })();
      }, p.state.idleMs);
    },

    /**
     * Después de guardar un archivo: según el modo de auto-compilación y según si el archivo entra en lo que compila el
     * perfil activo, se compila, se avisa o no se hace nada (5.3 del plan).
     */
    async despuesDeGuardar(rel) {
      const s = get();
      if (!s.project?.config || !s.rootFile) return;
      let info: FileInfo;
      try {
        info = await getBackend().fileInfo(rel);
      } catch {
        return;
      }
      if (info.partsChanged) await get().refrescarProyecto();
      const st = get().project?.state;
      if (!st || st.autoCompile === 'manual' || !info.profileAuto) return;
      if (info.affects === 'yes') {
        await get().compilar(undefined, { guardar: false });
      } else if (info.affects === 'other_part' && info.part) {
        const parte = info.part;
        if (st.outsideSave === 'build') await get().compilar(undefined, { guardar: false });
        else if (st.outsideSave === 'switch') await get().compilarParte(parte, { guardar: false });
        else {
          get().avisar(`Guardaste ${nombreDe(rel)}, que es de la parte «${nombreDe(parte)}» y el perfil activo no la incluye.`, 'info', {
            label: 'Compilar esta parte',
            run: () => void get().compilarParte(parte, { guardar: false }),
          });
        }
      }
    },

    // --- compilar -------------------------------------------------------------------------------------------------

    async compilar(perfil, opciones) {
      const s = get();
      if (!s.project) return s.avisar('Abrí una carpeta primero.');
      if (!s.rootFile) return s.avisar('Elegí la raíz del documento antes de compilar.');
      // Guardar todo y compilar (Ctrl+Enter): compilar con el disco viejo daría un PDF que no es lo que se ve.
      if (opciones?.guardar !== false && !(await get().guardarTodo({ auto: false }))) return;
      const yaCorria = get().build.status === 'running';
      if (!yaCorria) set((x) => ({ build: { ...x.build, status: 'running', ms: null, code: null, passes: null, pendiente: null } }));
      try {
        // Si ya hay un build corriendo, el core deja este pedido pendiente (y los pedidos seguidos se coalescen).
        const ack = await getBackend().build(perfil);
        if (ack.kind === 'queued') set((x) => ({ build: { ...x.build, pendiente: perfil ?? x.project?.state.activeProfile ?? null } }));
      } catch (e) {
        if (!yaCorria) set({ build: BUILD_INICIAL });
        get().avisar(mensajeDe(e), 'error');
      }
    },

    async cancelarBuild() {
      set((s) => ({ build: { ...s.build, pendiente: null } }));
      await getBackend().cancelBuild();
    },

    manejarEventoBuild(e) {
      if (e.type === 'queued') {
        set((s) => ({ build: { ...s.build, pendiente: e.perfil } }));
      } else if (e.type === 'error') {
        set((s) => ({ build: { ...s.build, pendiente: null } }));
        get().avisar(e.message, 'error');
      } else if (e.type === 'started') {
        // El reintento después de reparar un .aux sigue en el mismo log: el panel no se borra.
        if (e.retry) logBuffer.append(`\n$ ${e.cmdline}\n`);
        else {
          logBuffer.clear();
          logBuffer.append(`$ ${e.cmdline}\n`);
        }
        set({ build: { status: 'running', id: e.id, perfil: e.perfil, ms: null, code: null, cmdline: e.cmdline, passes: null, repaired: e.retry, pendiente: null } });
      } else if (e.type === 'log') {
        logBuffer.append(e.text);
      } else {
        const status: BuildStatus = e.cancelled ? 'cancelled' : e.ok ? 'ok' : 'fail';
        set((s) => {
          // Sólo se recarga el visor con un build bueno y, si no hubo cambios, sólo cuando todavía no hay PDF.
          const recarga = e.ok && e.pdf && (e.updated || s.pdfRel !== e.pdf);
          return {
            build: { ...s.build, status, id: e.id, perfil: e.perfil, ms: e.ms, code: e.code, passes: e.passes, repaired: e.repaired },
            ...(recarga ? { pdfRel: e.pdf, pdfEpoch: s.pdfEpoch + 1 } : {}),
            // Si falló o se cortó, el visor conserva el último PDF bueno y se lo marca como desactualizado.
            pdfStale: e.ok ? false : s.pdfRel !== null,
          };
        });
        const que = status === 'ok' ? 'terminó bien' : status === 'cancelled' ? 'cancelado' : `falló (código ${e.code ?? '?'})`;
        const pasadas = e.passes > 0 ? `, ${e.passes} pasada${e.passes === 1 ? '' : 's'}` : '';
        logBuffer.append(`\n== ${que} en ${(e.ms / 1000).toFixed(1)} s${pasadas}${e.repaired ? ' (después de reparar los auxiliares)' : ''}\n`);
      }
    },

    // --- perfiles y partes ----------------------------------------------------------------------------------------------

    async elegirPerfil(id) {
      await aplicarEstado({ activeProfile: id });
    },

    async alternarParte(nombre) {
      const sel = get().project?.state.selection ?? [];
      if (sel.includes(nombre)) {
        if (sel.length === 1) return; // un perfil de partes no puede quedarse sin ninguna
        await aplicarEstado({ selection: sel.filter((x) => x !== nombre) });
      } else {
        // En el orden del documento.
        const orden = get().project?.parts.map((p) => p.name) ?? [];
        await aplicarEstado({ selection: orden.filter((x) => x === nombre || sel.includes(x)) });
      }
    },

    async soloParte(nombre) {
      await aplicarEstado({ selection: [nombre] });
    },

    async todasLasPartes() {
      await aplicarEstado({ selection: get().project?.parts.map((p) => p.name) ?? [] });
    },

    async compilarParte(nombre, opciones) {
      const p = get().project;
      const activo = perfilActivo(p);
      // Sólo una parte: hace falta un perfil que compile "partes elegidas".
      const deSeleccion = activo?.parts === 'selection' ? activo : p?.config?.profiles.find((x) => x.parts === 'selection' && !x.hidden);
      const st = await aplicarEstado({ selection: [nombre], ...(deSeleccion ? { activeProfile: deSeleccion.id } : {}) });
      if (!st) return;
      await get().compilar(deSeleccion?.id, opciones);
    },

    async compilarParteActiva() {
      const rel = get().activeRel;
      if (!rel) return get().avisar('Abrí un archivo primero.');
      try {
        const info = await getBackend().fileInfo(rel);
        if (!info.part) return get().avisar(`${nombreDe(rel)} no pertenece a ninguna parte del proyecto.`);
        await get().compilarParte(info.part);
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
    },

    async setAutoCompile(modo) {
      if (temporizadorIdle && modo !== 'idle') {
        clearTimeout(temporizadorIdle);
        temporizadorIdle = null;
      }
      await aplicarEstado({ autoCompile: modo });
    },

    async setOutsideSave(o) {
      await aplicarEstado({ outsideSave: o });
    },

    async setVariable(nombre, valor) {
      await aplicarEstado({ variables: { [nombre]: valor } });
    },

    async publicar() {
      const s = get();
      const perfil = s.build.perfil ?? s.project?.state.activeProfile;
      if (!perfil) return;
      try {
        const r = await getBackend().publish(perfil);
        get().avisar(`Publicado: ${r.pdf}`);
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
    },

    async guardarConfig() {
      try {
        aplicarProyecto(await getBackend().saveConfig());
        get().avisar('latexviewer.json guardado en la carpeta del proyecto.');
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
    },

    mostrarPanel(p) {
      set({ panelIzq: p });
    },

    async permitirCierre() {
      const n = get().tabs.filter((t) => t.dirty).length;
      if (n === 0) return true;
      const r = await get().preguntar(`Hay ${n} archivo${n > 1 ? 's' : ''} sin guardar.`, [
        { id: 'guardar', label: 'Guardar todo y cerrar', primary: true },
        { id: 'descartar', label: 'Cerrar sin guardar' },
        { id: 'cancelar', label: 'Cancelar' },
      ]);
      if (r === 'guardar') return get().guardarTodo({ auto: false });
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

    avisar(texto, nivel = 'info', accion) {
      set({ notice: { texto, nivel, accion } });
    },

    cerrarAviso() {
      set({ notice: null });
    },
  };
});
