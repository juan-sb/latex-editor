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
  type Cocinando,
  type EstadoFiguras,
  type InformeReemplazo,
  type OpcionesBusqueda,
  type OutsideSave,
  type Problema,
  type ProfileInfo,
  type ProjectInfo,
  type ResultadoBusqueda,
  type Simbolos,
  type StatePatch,
} from '../backend';
import {
  aplicarProblemas,
  cerrarDoc,
  cerrarTodos,
  crearDoc,
  estaModificado,
  getDoc,
  hacerEditable,
  marcarGuardado,
  setDirtyListener,
  setEditListener,
  setSelectionListener,
} from '../editor/docs';
import { setFuenteSimbolos, setManejadorDefinicion } from '../editor/extensions';
import { pdfApi } from '../pdf/api';
import { describir, resolverDefinicion, resolverUsos, tokenEnCursor } from '../nav/definiciones';
import { refinarForward, refinarInverse } from '../sync/saltos';
import { logBuffer } from './logbuffer';
import { FILTRO_INICIAL, listaDeProblemas, siguiente, visibles, type FiltroProblemas } from './problemas';

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
  /** Lo que encontró el parser del log en el último build (null mientras no hay ninguno). */
  errors: number | null;
  warnings: number | null;
  badboxes: number | null;
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
export type PanelIzquierdo = 'archivos' | 'partes' | 'esquema' | 'buscar' | 'figuras';

/** Un renglón de un selector rápido (abrir archivo, paleta, ir a sección...). */
export interface QuickItem {
  id: string;
  titulo: string;
  detalle?: string;
  ejecutar: () => void | Promise<void>;
}

export interface QuickState {
  titulo: string;
  placeholder: string;
  items: QuickItem[];
}

/** Un lugar de un archivo, para el historial de saltos. */
export interface Ubicacion {
  rel: string;
  line: number;
}

export interface EstadoBusqueda extends OpcionesBusqueda {
  reemplazo: string;
  /** El campo de reemplazo está a la vista (Ctrl+Mayús+H). */
  conReemplazo: boolean;
  resultado: ResultadoBusqueda | null;
  buscando: boolean;
  error: string | null;
}

export const BUSQUEDA_INICIAL: EstadoBusqueda = {
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  allFiles: false,
  reemplazo: '',
  conReemplazo: false,
  resultado: null,
  buscando: false,
  error: null,
};
export type PanelInferior = 'problemas' | 'log';

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
  /** Los problemas del último build, el filtro del panel y cuál se visitó último (índice dentro de los visibles). */
  problems: Problema[];
  filtro: FiltroProblemas;
  problemaIdx: number;
  panelInferior: PanelInferior;
  /** Pedido de ir a una línea de un archivo (y, si trae `inicio` y `fin`, a seleccionar esa palabra): lo atiende el editor cuando la pestaña ya está activa. */
  irA: { rel: string; line: number; n: number; inicio?: number; fin?: number } | null;
  /** El estado del cache de figuras (panel Figuras): se pide al abrir, al terminar un build o una cocción, y al mostrar el panel. */
  figuras: EstadoFiguras | null;
  /** La cocción en curso, según sus eventos (el estado de arriba sólo cambia cuando se vuelve a pedir). */
  figProgreso: Cocinando | null;
  /** Hay una cocción de figuras esperando a que termine otro trabajo. */
  figPendiente: boolean;
  /** Lo que el core sabe del proyecto sin compilar (etiquetas, citas, secciones...), con el lint. */
  simbolos: Simbolos | null;
  quick: QuickState | null;
  /** Historial de saltos (Alt+←/→): los lugares por los que se pasó y cuál es el actual. */
  historial: Ubicacion[];
  histIdx: number;
  busqueda: EstadoBusqueda;
  /** "Seguir al cursor": el PDF acompaña al cursor del editor (6.5 del plan). Apagado por defecto. */
  seguir: boolean;
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
  mostrarPanelInferior(p: PanelInferior): void;
  cargarProblemas(perfil: string, abrirPanel?: boolean): Promise<void>;
  setFiltro(cambios: Partial<FiltroProblemas>): void;
  irAProblema(i: number): Promise<void>;
  cargarFiguras(): Promise<void>;
  cocinarFiguras(): Promise<void>;
  limpiarFiguras(): Promise<void>;
  manejarEventoFiguras(e: BuildEvent): void;
  cargarSimbolos(): Promise<void>;
  programarSimbolos(): void;
  abrirQuick(q: QuickState): void;
  cerrarQuick(): void;
  /** Va a un lugar de un archivo y recuerda de dónde venía (para Alt+←). */
  irAUbicacion(rel: string, line: number, opciones?: { inicio?: number; fin?: number; registrar?: boolean }): Promise<void>;
  registrarOrigen(): void;
  atras(): Promise<void>;
  adelante(): Promise<void>;
  irADefinicion(): Promise<void>;
  mostrarUsos(): Promise<void>;
  abrirArchivoRapido(): Promise<void>;
  irASeccion(ambito: 'archivo' | 'proyecto'): Promise<void>;
  pestanaSiguiente(dir: 1 | -1): void;
  /** Relee del disco una pestaña abierta (después de un reemplazo en el proyecto). */
  recargarPestana(rel: string): Promise<void>;
  setBusqueda(cambios: Partial<EstadoBusqueda>): void;
  ejecutarBusqueda(): Promise<void>;
  reemplazarTodo(archivos?: string[]): Promise<void>;
  irAlPdf(opciones?: { resaltar?: boolean; silencioso?: boolean }): Promise<boolean>;
  irAlCodigo(punto?: { page: number; x: number; y: number }): Promise<boolean>;
  setSeguir(valor: boolean): void;
  alMoverCursor(rel: string): void;
  saltarProblema(dir: 1 | -1): Promise<void>;
  alEditar(rel: string): void;
  despuesDeGuardar(rel: string): Promise<void>;
  actualizarParteActiva(): Promise<void>;
  permitirCierre(): Promise<boolean>;
  preguntar(mensaje: string, botones: DialogButton[], detalle?: string): Promise<string>;
  responderDialogo(id: string): void;
  avisar(texto: string, nivel?: 'info' | 'error', accion?: Notice['accion']): void;
  cerrarAviso(): void;
}

/** Los eventos de la cocción de figuras viajan por el mismo canal que los del build. */
const esDeFiguras = (e: BuildEvent): e is Extract<BuildEvent, { type: `bake${string}` }> => e.type.startsWith('bake');
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
  errors: null,
  warnings: null,
  badboxes: null,
};

let inicializado = false;
/** Las preguntas se encolan: dos diálogos a la vez se pisarían. */
let colaDePreguntas: Promise<unknown> = Promise.resolve();
/** Autoguardado "al dejar de tipear": un solo temporizador para todo el proyecto. */
let temporizadorIdle: ReturnType<typeof setTimeout> | null = null;
let ultimoEditado: string | null = null;
/** El índice de símbolos se rehace 500 ms después del último guardado. */
let temporizadorSimbolos: ReturnType<typeof setTimeout> | null = null;
/** Para que una búsqueda lenta no pise el resultado de una más nueva. */
let contadorBusqueda = 0;
/** "Seguir al cursor": el salto se pide 200 ms después del último movimiento del cursor. */
let temporizadorSeguir: ReturnType<typeof setTimeout> | null = null;

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
  setSelectionListener((rel) => get().alMoverCursor(rel));
  setFuenteSimbolos(() => get().simbolos);
  setManejadorDefinicion(() => void get().irADefinicion());

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
    problems: [],
    filtro: FILTRO_INICIAL,
    problemaIdx: -1,
    panelInferior: 'log',
    irA: null,
    simbolos: null,
    figuras: null,
    figProgreso: null,
    figPendiente: false,
    quick: null,
    historial: [],
    histIdx: -1,
    busqueda: BUSQUEDA_INICIAL,
    seguir: false,
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
        problems: [],
        problemaIdx: -1,
        irA: null,
        simbolos: null,
        figuras: null,
        figProgreso: null,
        figPendiente: false,
        quick: null,
        historial: [],
        histIdx: -1,
        busqueda: BUSQUEDA_INICIAL,
        notice: null,
      });
      aplicarProblemas([]);
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
      void get().cargarSimbolos();
      void get().cargarFiguras();
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

    async recargarPestana(rel) {
      if (!getDoc(rel)) return;
      try {
        const r = await getBackend().readFile(rel);
        cerrarDoc(rel);
        const e = crearDoc(rel, r);
        const epoch = (get().tabs.find((t) => t.rel === rel)?.epoch ?? 0) + 1;
        actualizarTab(rel, { dirty: false, readOnly: e.readOnly, mixed: e.mixed, eol: e.eol, bom: e.bom, epoch });
      } catch (err) {
        get().avisar(`No se pudo releer ${rel}: ${mensajeDe(err)}`, 'error');
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
      get().programarSimbolos();
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
      if (esDeFiguras(e)) {
        get().manejarEventoFiguras(e);
      } else if (e.type === 'queued') {
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
        set({ build: { status: 'running', id: e.id, perfil: e.perfil, ms: null, code: null, cmdline: e.cmdline, passes: null, repaired: e.retry, pendiente: null, errors: null, warnings: null, badboxes: null } });
      } else if (e.type === 'log') {
        logBuffer.append(e.text);
      } else {
        const status: BuildStatus = e.cancelled ? 'cancelled' : e.ok ? 'ok' : 'fail';
        set((s) => {
          // Sólo se recarga el visor con un build bueno y, si no hubo cambios, sólo cuando todavía no hay PDF.
          const recarga = e.ok && e.pdf && (e.updated || s.pdfRel !== e.pdf);
          return {
            build: { ...s.build, status, id: e.id, perfil: e.perfil, ms: e.ms, code: e.code, passes: e.passes, repaired: e.repaired, errors: e.errors, warnings: e.warnings, badboxes: e.badboxes },
            ...(recarga ? { pdfRel: e.pdf, pdfEpoch: s.pdfEpoch + 1 } : {}),
            // Si falló o se cortó, el visor conserva el último PDF bueno y se lo marca como desactualizado.
            pdfStale: e.ok ? false : s.pdfRel !== null,
          };
        });
        // Un build cortado deja un log a medias: se conservan los problemas del anterior. Si hubo errores, el panel de
        // problemas se abre solo (5.7 del plan).
        if (!e.cancelled) void get().cargarProblemas(e.perfil, e.errors > 0);
        // Un build puede haber cocinado figuras por su cuenta (pgf cocina de a una las que faltan) o haber descartado alguna rota.
        void get().cargarFiguras();
        const que = status === 'ok' ? 'terminó bien' : status === 'cancelled' ? 'cancelado' : `falló (código ${e.code ?? '?'})`;
        const pasadas = e.passes > 0 ? `, ${e.passes} pasada${e.passes === 1 ? '' : 's'}` : '';
        logBuffer.append(`\n== ${que} en ${(e.ms / 1000).toFixed(1)} s${pasadas}${e.repaired ? ' (después de reparar los auxiliares)' : ''}\n`);
      }
    },

    // --- cache de figuras (F6) ----------------------------------------------------------------------------------------------

    async cargarFiguras() {
      if (!get().project?.rootFile) return set({ figuras: null });
      try {
        set({ figuras: await getBackend().figuresStatus() });
      } catch {
        // Sin configuración o con un proyecto a medio escribir el estado de las figuras no es crítico.
      }
    },

    async cocinarFiguras() {
      if (!get().project) return get().avisar('Abrí una carpeta primero.');
      try {
        const ack = await getBackend().figuresBake();
        if (ack.kind === 'queued') set({ figPendiente: true });
        else set({ figProgreso: { fase: 'todo', hechas: 0, total: 0, listando: true } });
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
    },

    /** Muestra qué borraría la limpieza (archivos y MB), pide confirmación y la hace. Nunca limpia sin preguntar. */
    async limpiarFiguras() {
      let vista;
      try {
        vista = await getBackend().figuresCleanPreview();
      } catch (e) {
        return get().avisar(mensajeDe(e), 'error');
      }
      if (vista.archivos.length === 0) return get().avisar('No hay nada que limpiar: el cache sólo tiene figuras que el proyecto usa.');
      const mb = (vista.bytes / 1048576).toFixed(1);
      const r = await get().preguntar(
        `Borrar ${vista.archivos.length} archivos de ${vista.figuras} figura${vista.figuras === 1 ? '' : 's'} que el proyecto ya no usa (${mb} MB)?`,
        [
          { id: 'limpiar', label: 'Limpiar', primary: true },
          { id: 'cancelar', label: 'Cancelar' },
        ],
        'Son figuras de sellos anteriores (por ejemplo, antes de cambiar el estilo) o de figuras que ya no están en el documento. Si hacen falta, se vuelven a cocinar.',
      );
      if (r !== 'limpiar') return;
      try {
        const h = await getBackend().figuresClean();
        get().avisar(`Se borraron ${h.archivos.length} archivos (${(h.bytes / 1048576).toFixed(1)} MB).`);
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
      await get().cargarFiguras();
    },

    manejarEventoFiguras(e) {
      if (e.type === 'bakequeued') {
        set({ figPendiente: true });
      } else if (e.type === 'bakelisting') {
        set({ figPendiente: false, figProgreso: { fase: e.fase, hechas: 0, total: 0, listando: true } });
      } else if (e.type === 'bakestarted') {
        set({ figProgreso: { fase: e.fase, hechas: 0, total: e.total, listando: false } });
      } else if (e.type === 'bakeprogress') {
        set((s) => ({ figProgreso: { fase: s.figProgreso?.fase ?? '', hechas: e.done, total: e.total, listando: false } }));
      } else if (e.type === 'bakefinished') {
        set({ figProgreso: null, figPendiente: false });
        void get().cargarFiguras();
        if (e.error) get().avisar(`No se pudieron cocinar las figuras: ${e.error}`, 'error');
        else if (e.failed > 0) {
          get().avisar(`${e.failed} figura${e.failed === 1 ? '' : 's'} no salieron: están en el panel Figuras, con su error.`, 'error');
          set({ panelIzq: 'figuras' });
        }
        // Un build que esperaba esta cocción y no va a correr (se canceló o no se pudo cocinar): no se queda "compilando".
        const s = get().build;
        if ((e.cancelled || e.error) && s.status === 'running' && s.id === null) set({ build: BUILD_INICIAL });
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
      if (p === 'figuras') void get().cargarFiguras();
      set({ panelIzq: p });
    },

    mostrarPanelInferior(p) {
      set({ panelInferior: p });
    },

    // --- problemas ----------------------------------------------------------------------------------------------------

    async cargarProblemas(perfil, abrirPanel) {
      try {
        const lista = await getBackend().problems(perfil);
        set({ problems: lista, problemaIdx: -1, ...(abrirPanel && lista.length > 0 ? { panelInferior: 'problemas' as const } : {}) });
        aplicarProblemas(visibles(listaDeProblemas(lista, get().simbolos), get().filtro));
      } catch (e) {
        get().avisar(`No se pudieron leer los problemas del build: ${mensajeDe(e)}`, 'error');
      }
    },

    setFiltro(cambios) {
      const filtro = { ...get().filtro, ...cambios };
      set({ filtro, problemaIdx: -1 });
      aplicarProblemas(visibles(listaDeProblemas(get().problems, get().simbolos), filtro));
    },

    async irAProblema(i) {
      const p = visibles(listaDeProblemas(get().problems, get().simbolos), get().filtro)[i];
      if (!p) return;
      set({ problemaIdx: i });
      if (!p.file || p.line === null) {
        return get().avisar(`«${p.message}» no tiene una ubicación en un archivo del proyecto.`);
      }
      await get().irAUbicacion(p.file, p.line);
    },

    // --- símbolos, navegación, selectores y búsqueda (F5) ---------------------------------------------------------------------

    async cargarSimbolos() {
      if (!get().project?.rootFile) return;
      try {
        const simbolos = await getBackend().getSymbols();
        set({ simbolos });
        // El lint entra en las marcas del gutter junto con los problemas del build.
        aplicarProblemas(visibles(listaDeProblemas(get().problems, simbolos), get().filtro));
      } catch {
        // Sin raíz o con un proyecto a medio escribir el índice no es crítico: se vuelve a pedir con el próximo guardado.
      }
    },

    programarSimbolos() {
      if (temporizadorSimbolos) clearTimeout(temporizadorSimbolos);
      temporizadorSimbolos = setTimeout(() => {
        temporizadorSimbolos = null;
        void get().cargarSimbolos();
      }, 500);
    },

    abrirQuick(q) {
      set({ quick: q });
    },

    cerrarQuick() {
      set({ quick: null });
    },

    registrarOrigen() {
      const rel = get().activeRel;
      const doc = rel ? getDoc(rel) : undefined;
      if (!rel || !doc) return;
      const origen: Ubicacion = { rel, line: doc.state.doc.lineAt(doc.state.selection.main.head).number };
      const { historial, histIdx } = get();
      const hasta = historial.slice(0, histIdx + 1);
      // El lugar actual reemplaza al último del historial si es el mismo archivo y línea; si no, se agrega.
      const ultimo = hasta[hasta.length - 1];
      if (!ultimo || ultimo.rel !== origen.rel || ultimo.line !== origen.line) hasta.push(origen);
      set({ historial: hasta.slice(-100), histIdx: Math.min(hasta.length, 100) - 1 });
    },

    async irAUbicacion(rel, line, opciones) {
      if (opciones?.registrar !== false) get().registrarOrigen();
      await get().abrirArchivo(rel);
      if (!getDoc(rel)) return;
      set({ irA: { rel, line, n: Date.now(), inicio: opciones?.inicio, fin: opciones?.fin } });
      if (opciones?.registrar !== false) {
        // El destino queda como "lugar actual" del historial: se puede volver a él con Alt+→.
        const { historial, histIdx } = get();
        const hasta = historial.slice(0, histIdx + 1);
        hasta.push({ rel, line });
        set({ historial: hasta.slice(-100), histIdx: Math.min(hasta.length, 100) - 1 });
      }
    },

    async atras() {
      const { historial, histIdx } = get();
      if (histIdx <= 0) return get().avisar('No hay un lugar anterior al que volver.');
      // El lugar actual se actualiza (el cursor se movió desde que se llegó) antes de salir de él.
      const actual = get().activeRel ? getDoc(get().activeRel!) : undefined;
      const copia = [...historial];
      if (actual && get().activeRel) copia[histIdx] = { rel: get().activeRel!, line: actual.state.doc.lineAt(actual.state.selection.main.head).number };
      const destino = copia[histIdx - 1];
      set({ historial: copia, histIdx: histIdx - 1 });
      await get().irAUbicacion(destino.rel, destino.line, { registrar: false });
    },

    async adelante() {
      const { historial, histIdx } = get();
      if (histIdx >= historial.length - 1) return get().avisar('No hay un lugar siguiente.');
      const actual = get().activeRel ? getDoc(get().activeRel!) : undefined;
      const copia = [...historial];
      if (actual && get().activeRel) copia[histIdx] = { rel: get().activeRel!, line: actual.state.doc.lineAt(actual.state.selection.main.head).number };
      const destino = copia[histIdx + 1];
      set({ historial: copia, histIdx: histIdx + 1 });
      await get().irAUbicacion(destino.rel, destino.line, { registrar: false });
    },

    /** F12 / Ctrl+clic: a la definición de lo que hay bajo el cursor (etiqueta, clave, archivo, comando, entorno). */
    async irADefinicion() {
      const rel = get().activeRel;
      const doc = rel ? getDoc(rel) : undefined;
      if (!rel || !doc) return;
      const linea = doc.state.doc.lineAt(doc.state.selection.main.head);
      const token = tokenEnCursor(linea.text, doc.state.selection.main.head - linea.from);
      if (!token) return get().avisar('No hay nada con definición bajo el cursor.');
      if (!get().simbolos) await get().cargarSimbolos();
      const s = get().simbolos;
      const destino = s ? resolverDefinicion(token, s) : null;
      if (!destino) return get().avisar(`No encontré la definición de ${describir(token)} en el proyecto.`);
      if (destino.imagen) return get().avisar(`${describir(token)}: ${destino.rel}`);
      await get().irAUbicacion(destino.rel, destino.line);
    },

    /** Shift+F12: dónde se usa la etiqueta o la clave bajo el cursor, en un selector. */
    async mostrarUsos() {
      const rel = get().activeRel;
      const doc = rel ? getDoc(rel) : undefined;
      if (!rel || !doc) return;
      const linea = doc.state.doc.lineAt(doc.state.selection.main.head);
      const token = tokenEnCursor(linea.text, doc.state.selection.main.head - linea.from);
      if (!token) return get().avisar('Poné el cursor sobre una etiqueta o una clave de cita.');
      if (!get().simbolos) await get().cargarSimbolos();
      const usos = get().simbolos ? resolverUsos(token, get().simbolos!) : [];
      if (usos.length === 0) return get().avisar(`${describir(token)} no se usa en ninguna parte del proyecto.`);
      get().abrirQuick({
        titulo: `Dónde se usa ${describir(token)}`,
        placeholder: 'Filtrar por archivo…',
        items: usos.map((u, i) => ({ id: `${i}`, titulo: `${u.file}:${u.line}`, detalle: `\\${u.comando}`, ejecutar: () => get().irAUbicacion(u.file, u.line) })),
      });
    },

    /** Ctrl+P: abrir un archivo del proyecto por su nombre. */
    async abrirArchivoRapido() {
      if (!get().project) return get().avisar('Abrí una carpeta primero.');
      if (!get().simbolos) await get().cargarSimbolos();
      const archivos = (get().simbolos?.files ?? []).filter((f) => f.kind !== 'image');
      const abiertos = new Set(get().tabs.map((t) => t.rel));
      get().abrirQuick({
        titulo: 'Abrir archivo',
        placeholder: 'Nombre del archivo…',
        // Los que ya están abiertos primero: es lo que más se vuelve a buscar.
        items: [...archivos].sort((a, b) => Number(abiertos.has(b.rel)) - Number(abiertos.has(a.rel))).map((f) => ({
          id: f.rel,
          titulo: f.rel,
          detalle: abiertos.has(f.rel) ? 'abierto' : f.kind,
          ejecutar: () => get().irAUbicacion(f.rel, 1),
        })),
      });
    },

    /** Ctrl+Mayús+O (este archivo) y Ctrl+T (todo el proyecto): secciones y etiquetas. */
    async irASeccion(ambito) {
      if (!get().project) return get().avisar('Abrí una carpeta primero.');
      if (!get().simbolos) await get().cargarSimbolos();
      const s = get().simbolos;
      if (!s) return;
      const activo = get().activeRel;
      const eligen = (f: string) => ambito === 'proyecto' || f === activo;
      const secciones = s.sections.filter((x) => eligen(x.file)).map((x) => ({
        id: `s:${x.file}:${x.line}`,
        titulo: `${'  '.repeat(Math.max(0, x.level - 1))}§ ${x.title || '(sin título)'}`,
        detalle: ambito === 'proyecto' ? `${x.file}:${x.line}` : `línea ${x.line}`,
        ejecutar: () => get().irAUbicacion(x.file, x.line),
      }));
      const etiquetas = s.labels.filter((x) => eligen(x.file)).map((x) => ({
        id: `l:${x.file}:${x.line}:${x.name}`,
        titulo: `⚑ ${x.name}`,
        detalle: x.context || (ambito === 'proyecto' ? `${x.file}:${x.line}` : `línea ${x.line}`),
        ejecutar: () => get().irAUbicacion(x.file, x.line),
      }));
      get().abrirQuick({
        titulo: ambito === 'proyecto' ? 'Ir a sección o etiqueta del proyecto' : 'Ir a sección o etiqueta de este archivo',
        placeholder: 'Título o nombre de la etiqueta…',
        items: [...secciones, ...etiquetas],
      });
    },

    pestanaSiguiente(dir) {
      const { tabs, activeRel } = get();
      if (tabs.length < 2) return;
      const i = tabs.findIndex((t) => t.rel === activeRel);
      get().activar(tabs[(i + dir + tabs.length) % tabs.length].rel);
    },

    setBusqueda(cambios) {
      set((x) => ({ busqueda: { ...x.busqueda, ...cambios } }));
    },

    async ejecutarBusqueda() {
      const b = get().busqueda;
      if (!b.query) return set((x) => ({ busqueda: { ...x.busqueda, resultado: null, error: null } }));
      const marca = ++contadorBusqueda;
      set((x) => ({ busqueda: { ...x.busqueda, buscando: true, error: null } }));
      try {
        const opciones: OpcionesBusqueda = { query: b.query, regex: b.regex, caseSensitive: b.caseSensitive, wholeWord: b.wholeWord, allFiles: b.allFiles };
        const r = await getBackend().searchProject(opciones, b.conReemplazo && b.reemplazo !== '' ? b.reemplazo : undefined);
        // Una búsqueda más nueva ya salió: ésta no pisa su resultado.
        if (marca === contadorBusqueda) set((x) => ({ busqueda: { ...x.busqueda, resultado: r, buscando: false } }));
      } catch (e) {
        if (marca === contadorBusqueda) set((x) => ({ busqueda: { ...x.busqueda, resultado: null, buscando: false, error: mensajeDe(e) } }));
      }
    },

    /** Reemplaza en disco. Los archivos abiertos con cambios sin guardar se guardan antes (o se cancela), y los abiertos se releen después. */
    async reemplazarTodo(archivos) {
      const b = get().busqueda;
      const r = b.resultado;
      if (!r || r.total === 0) return;
      const objetivo = archivos ?? r.files.map((f) => f.file);
      const n = r.files.filter((f) => objetivo.includes(f.file)).reduce((t, f) => t + f.matches.length, 0);
      const sucios = get().tabs.filter((t) => t.dirty && objetivo.includes(t.rel));
      const resp = await get().preguntar(
        `Reemplazar ${n} coincidencia${n === 1 ? '' : 's'} de «${b.query}» por «${b.reemplazo}» en ${objetivo.length} archivo${objetivo.length === 1 ? '' : 's'}?`,
        [
          { id: 'reemplazar', label: sucios.length ? 'Guardar los abiertos y reemplazar' : 'Reemplazar', primary: true },
          { id: 'cancelar', label: 'Cancelar' },
        ],
        sucios.length ? `Hay cambios sin guardar en: ${sucios.map((t) => t.name).join(', ')}. Se guardan antes de reemplazar.` : 'Se escribe en disco, conservando el salto de línea y el BOM de cada archivo.',
      );
      if (resp !== 'reemplazar') return;
      for (const t of sucios) {
        const g = await get().guardar(t.rel, { auto: false });
        if (g === 'cancelado' || g === 'error') return;
      }
      try {
        const opciones: OpcionesBusqueda = { query: b.query, regex: b.regex, caseSensitive: b.caseSensitive, wholeWord: b.wholeWord, allFiles: b.allFiles };
        const informe: InformeReemplazo = await getBackend().replaceProject(opciones, b.reemplazo, objetivo);
        // Los archivos abiertos que cambiaron se releen del disco: el editor no puede quedarse con el texto viejo.
        for (const [rel] of informe.changed) if (getDoc(rel)) await get().recargarPestana(rel);
        const salteados = informe.skipped.length ? ` Se saltearon ${informe.skipped.length}: ${informe.skipped.map(([f, why]) => `${f} (${why})`).join('; ')}.` : '';
        get().avisar(`Se reemplazaron ${informe.total} coincidencia${informe.total === 1 ? '' : 's'} en ${informe.changed.length} archivo${informe.changed.length === 1 ? '' : 's'}.${salteados}`, informe.skipped.length ? 'error' : 'info');
        await get().ejecutarBusqueda();
        get().programarSimbolos();
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
      }
    },

    // --- SyncTeX ----------------------------------------------------------------------------------------------------

    /**
     * Del cursor al PDF (6.2 del plan). SyncTeX da las cajas de la línea; la palabra del cursor (con contexto) se busca en
     * la capa de texto del PDF adentro de esas cajas y se resalta; si no aparece, se resaltan las cajas de la línea. Si el
     * PDF elegido por especificidad no es el que se muestra, se cambia y se avisa.
     */
    async irAlPdf(opciones) {
      const resaltar = opciones?.resaltar ?? true;
      const silencioso = opciones?.silencioso ?? false;
      const rel = get().activeRel;
      const doc = rel ? getDoc(rel) : undefined;
      if (!rel || !doc) {
        if (!silencioso) get().avisar('Abrí un archivo y poné el cursor donde quieras ir en el PDF.');
        return false;
      }
      const cabeza = doc.state.selection.main.head;
      const linea = doc.state.doc.lineAt(cabeza);
      let res;
      try {
        res = await getBackend().synctexForward(rel, linea.number);
      } catch (e) {
        if (!silencioso) get().avisar(mensajeDe(e), 'error');
        return false;
      }
      if (!res) {
        if (!silencioso) get().avisar('Este archivo todavía no está en el PDF: compilá con un perfil que lo incluya.');
        return false;
      }
      if (res.pdf !== get().pdfRel) {
        // En "seguir al cursor" no se cambia de PDF por la libre: sólo con un salto pedido.
        if (silencioso) return false;
        set((s) => ({ pdfRel: res.pdf, pdfEpoch: s.pdfEpoch + 1, pdfStale: false }));
        get().avisar(`Mostrando el PDF del perfil «${res.perfil}»: es el que tiene este archivo.`);
        const etiqueta = () => `${get().pdfRel}#${get().pdfEpoch}`;
        for (let i = 0; i < 400 && pdfApi.host?.etiqueta !== etiqueta(); i++) await new Promise((r) => setTimeout(r, 50));
      }
      const host = pdfApi.host;
      if (!host) return false;
      const { rects } = await refinarForward(host, res, linea.text, cabeza - linea.from);
      host.mostrar(rects[0].page, rects[0]);
      if (resaltar) host.resaltar(rects[0].page, rects);
      return true;
    },

    /** Del PDF al código (6.3 del plan): `punto` es lo clickeado (o, sin él, el centro de lo que se ve). */
    async irAlCodigo(punto) {
      const host = pdfApi.host;
      const p = punto ?? host?.centroVisible();
      const perfil = get().pdfRel?.split('/')[2];
      if (!host || !p || !perfil) {
        get().avisar('Todavía no hay un PDF para saltar al código.');
        return false;
      }
      let res;
      try {
        res = await getBackend().synctexInverse(perfil, p.page, p.x, p.y);
      } catch (e) {
        get().avisar(mensajeDe(e), 'error');
        return false;
      }
      if (!res || !res.file) {
        get().avisar('Ese texto no viene de un archivo de tu proyecto (puede ser de una macro o del sistema).');
        return false;
      }
      await get().abrirArchivo(res.file);
      const doc = getDoc(res.file);
      if (!doc) return false;
      const ubic = await refinarInverse(host, p, res, { lineas: doc.state.doc.lines, texto: (n) => doc.state.doc.line(n).text });
      get().registrarOrigen();
      set({ irA: { rel: res.file, line: ubic.line, n: Date.now(), inicio: ubic.inicio, fin: ubic.fin } });
      return true;
    },

    setSeguir(valor) {
      set({ seguir: valor });
      if (valor) void get().irAlPdf({ resaltar: false, silencioso: true });
    },

    alMoverCursor(rel) {
      if (!get().seguir || rel !== get().activeRel) return;
      if (temporizadorSeguir) clearTimeout(temporizadorSeguir);
      temporizadorSeguir = setTimeout(() => {
        temporizadorSeguir = null;
        void get().irAlPdf({ resaltar: false, silencioso: true });
      }, 200);
    },

    async saltarProblema(dir) {
      const lista = visibles(listaDeProblemas(get().problems, get().simbolos), get().filtro);
      const actual = get().problemaIdx;
      const i = siguiente(lista, actual < 0 ? (dir === 1 ? -1 : 0) : actual, dir);
      if (i < 0) return get().avisar(lista.length === 0 ? 'No hay problemas en el último build.' : 'Ningún problema tiene una ubicación en un archivo.');
      await get().irAProblema(i);
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
