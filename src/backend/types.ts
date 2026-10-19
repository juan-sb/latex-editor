// Tipos del protocolo entre la interfaz y el core. Espejo de lo que serializa `lv-core` (serde): si cambia allá,
// cambia acá. Todas las rutas son relativas a la raíz del proyecto y llevan `/`.
// Las vistas del proyecto (`ProjectInfo`, `State`) viajan en camelCase; los eventos del build y las entradas de carpeta,
// en snake_case, como salen del core.

export type Eol = 'lf' | 'crlf' | 'cr';

export type PartsSel = 'selection' | 'all' | 'one';

export interface ProfileInfo {
  id: string;
  label: string;
  partial: boolean;
  externalize: boolean;
  parts: PartsSel;
  cleanBefore: boolean;
  /** Puede ser el perfil que compila el guardado. */
  autoCompile: boolean;
  hidden: boolean;
}

export interface VariableInfo {
  name: string;
  label: string;
  choices: string[];
  default: string | null;
}

export interface ConfigInfo {
  engine: string;
  profiles: ProfileInfo[];
  variables: VariableInfo[];
  /** Dónde publica el proyecto (`publish.dir`), si lo dice. */
  publishDir: string | null;
}

export type AutoCompileMode = 'save' | 'idle' | 'manual';
export type OutsideSave = 'warn' | 'switch' | 'build';

/** `.lv/state.json`: lo de esta máquina. */
export interface AppStateInfo {
  root: string | null;
  activeProfile: string | null;
  /** Nombres de las partes tildadas, tal como los lleva `\includeonly`. */
  selection: string[];
  variables: Record<string, string>;
  autoCompile: AutoCompileMode;
  idleMs: number;
  outsideSave: OutsideSave;
}

export type StatePatch = Partial<Omit<AppStateInfo, 'root'>>;

export interface PartInfo {
  name: string;
  file: string | null;
  command: string;
}

export interface ProjectInfo {
  name: string;
  root: string;
  candidates: string[];
  rootFile: string | null;
  /** `latexviewer.json` existe en disco; si no, la configuración es la inferida. */
  configSaved: boolean;
  /** El `latexviewer.json` que hay no se pudo leer. */
  configError: string | null;
  config: ConfigInfo | null;
  state: AppStateInfo;
  parts: PartInfo[];
  indexMs: number;
}

export interface FileInfo {
  /** La parte a la que pertenece el archivo, si es de alguna. */
  part: string | null;
  affects: 'yes' | 'other_part' | 'unrelated';
  /** El perfil activo puede compilar al guardar. */
  profileAuto: boolean;
  /** Las partes del proyecto cambiaron (por ejemplo, se agregó un `\Capitulo`). */
  partsChanged: boolean;
}

export type BuildAck = { kind: 'started'; id: number } | { kind: 'queued' };

export interface Published {
  pdf: string;
  synctex: string | null;
}

export type Severidad = 'error' | 'warning' | 'badbox';

/** Un problema que el parser sacó del log del último build (`lv-core::logparse`). */
export interface Problema {
  severity: Severidad;
  kind: string;
  message: string;
  /** Relativo a la raíz; `null` si el archivo es del sistema o no se pudo atribuir. */
  file: string | null;
  line: number | null;
  line_end: number | null;
  /** Lo que TeX muestra del lugar del error, en una línea. */
  context: string;
}

/** Un rectángulo del PDF en bp, con el origen arriba a la izquierda (el espacio de SyncTeX). */
export interface RectBp {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Del cursor al PDF: en qué perfil está el PDF elegido y las cajas de línea de esa línea del fuente. */
export interface SyncForward {
  perfil: string;
  pdf: string;
  page: number;
  rects: RectBp[];
  line_used: number;
}

/** Del PDF al código. `file` es `null` si el texto viene de un archivo del sistema o de una macro del driver. */
export interface SyncInverse {
  file: string | null;
  line: number;
  inside: boolean;
}

/** Un `\label` del proyecto. */
export interface EtiquetaSim {
  name: string;
  file: string;
  line: number;
  /** La línea donde está, sin el `\label{...}`. */
  context: string;
}

/** Un `ef` o una cita: el nombre al que apunta y dónde está. */
export interface UsoSim {
  name: string;
  command: string;
  file: string;
  line: number;
}

export interface EntradaBib {
  key: string;
  kind: string;
  file: string;
  line: number;
  author: string;
  title: string;
  year: string;
}

export interface SeccionSim {
  /** 0 `\part`, 1 `\chapter`, 2 `\section`, 3 `\subsection`, 4 `\subsubsection`, 5 `\paragraph`, 6 `\subparagraph`. */
  level: number;
  title: string;
  file: string;
  line: number;
  label: string | null;
}

export interface DefSim {
  name: string;
  kind: 'command' | 'operator' | 'environment' | 'theorem' | 'tcolorbox' | 'def';
  file: string;
  line: number;
  args: number;
}

export interface ArchivoSim {
  rel: string;
  kind: 'tex' | 'bib' | 'image';
}

/** Lo que sabe el core del proyecto sin compilar: etiquetas, citas, secciones, definiciones, archivos y el lint. */
export interface Simbolos {
  labels: EtiquetaSim[];
  refs: UsoSim[];
  cites: UsoSim[];
  bib: EntradaBib[];
  sections: SeccionSim[];
  defs: DefSim[];
  files: ArchivoSim[];
  lint: Problema[];
  scan_ms: number;
}

export interface OpcionesBusqueda {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Todo el árbol de texto, no sólo los archivos del grafo y los `.bib`. */
  allFiles: boolean;
}

export interface CoincidenciaBusqueda {
  line: number;
  /** En unidades UTF-16, como las posiciones del editor. */
  col: number;
  len: number;
  text: string;
  /** Dónde empieza `text` dentro de la línea (si se recortó). */
  offset: number;
  /** En una vista previa de reemplazo: lo que quedaría en lugar de la coincidencia. */
  replaced: string | null;
}

export interface ArchivoBusqueda {
  file: string;
  matches: CoincidenciaBusqueda[];
}

export interface ResultadoBusqueda {
  files: ArchivoBusqueda[];
  total: number;
  truncated: boolean;
  files_scanned: number;
  ms: number;
}

export interface InformeReemplazo {
  changed: [string, number][];
  skipped: [string, string][];
  total: number;
}

export interface DirEntry {
  name: string;
  rel: string;
  is_dir: boolean;
  size: number;
}

export interface FileRead {
  /** Normalizado a `\n`. */
  text: string;
  eol: Eol;
  bom: boolean;
  /** Más de un tipo de salto de línea: el editor lo abre en sólo lectura. */
  mixed: boolean;
  version: string;
}

export interface WriteOutcome {
  written: boolean;
  version: string;
}

export type BuildEvent =
  | { type: 'queued'; perfil: string }
  | { type: 'started'; id: number; perfil: string; cmdline: string; retry: boolean }
  | { type: 'log'; id: number; text: string }
  | {
      type: 'finished';
      id: number;
      perfil: string;
      ok: boolean;
      code: number | null;
      cancelled: boolean;
      ms: number;
      pdf: string | null;
      updated: boolean;
      passes: number;
      truncated_aux: boolean;
      repaired: boolean;
      errors: number;
      warnings: number;
      badboxes: number;
    }
  | { type: 'error'; message: string };

export interface LaunchOptions {
  open: string | null;
  root: string | null;
  smoke: boolean;
  /** Qué smoke de aceptación corre la interfaz con `LV_SMOKE`: el de F1, F2, F3 o F4. */
  smokeMode: 'f1' | 'f2' | 'f3' | 'f4' | 'f5';
  smokeFile: string | null;
  /** Milisegundos que el smoke deja la interfaz abierta al terminar (para sacarle una captura). */
  smokePausaMs: number;
}

export type ErrorKind = 'invalid_path' | 'not_found' | 'not_text' | 'invalid_text' | 'conflict' | 'io' | 'busy' | 'no_latexmk' | 'other';

/** Error del core, ya traducido: `kind` permite distinguir un conflicto de versión de un error de disco. */
export class BackendError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly diskVersion?: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Lo único que la interfaz sabe del mundo exterior. La implementación de Tauri está en `tauri.ts` y es el único
 * archivo que usa `invoke` y `listen`; los tests usan una simulada. Mañana puede haber otra contra un servidor.
 */
export interface Backend {
  launchOptions(): Promise<LaunchOptions>;
  pickFolder(): Promise<string | null>;
  openProject(path: string): Promise<ProjectInfo>;
  /** Vuelve a leer el proyecto del disco (índice de partes incluido). */
  getProject(): Promise<ProjectInfo>;
  setRootFile(rel: string): Promise<ProjectInfo>;
  setState(patch: StatePatch): Promise<AppStateInfo>;
  /** Escribe `latexviewer.json` con la configuración actual. */
  saveConfig(): Promise<ProjectInfo>;
  /** Qué pasa con el archivo respecto del perfil activo. Se llama justo después de guardarlo. */
  fileInfo(rel: string): Promise<FileInfo>;
  listDir(rel: string): Promise<DirEntry[]>;
  readFile(rel: string): Promise<FileRead>;
  /** `expectedVersion`: la que devolvió `readFile` o el último `writeFile`; `null` sólo para un archivo nuevo. */
  writeFile(rel: string, text: string, expectedVersion: string | null): Promise<WriteOutcome>;
  readPdf(rel: string): Promise<Uint8Array>;
  /** Pide un build del perfil (el activo si no se dice). Si ya hay uno corriendo queda pendiente y corre una vez después. */
  build(profile?: string): Promise<BuildAck>;
  cancelBuild(): Promise<boolean>;
  /** Los problemas del último build del perfil. */
  problems(profile: string): Promise<Problema[]>;
  /** Del cursor al PDF. `null` si el archivo todavía no figura en el SyncTeX del PDF elegido. */
  synctexForward(rel: string, line: number): Promise<SyncForward | null>;
  /** Del PDF al código: `(page, x, y)` en bp desde arriba a la izquierda. */
  synctexInverse(profile: string, page: number, x: number, y: number): Promise<SyncInverse | null>;
  /** Etiquetas, citas, secciones, definiciones y archivos del proyecto, con el lint. */
  getSymbols(): Promise<Simbolos>;
  /** Con `replacement`, cada coincidencia trae lo que quedaría (vista previa). */
  searchProject(options: OpcionesBusqueda, replacement?: string): Promise<ResultadoBusqueda>;
  /** Reemplaza en disco (conserva EOL y BOM). `files`: sólo esos; sin él, todos los que tengan coincidencias. */
  replaceProject(options: OpcionesBusqueda, replacement: string, files?: string[]): Promise<InformeReemplazo>;
  /** Un archivo de la configuración del usuario (por ejemplo `keybindings.json`); `null` si no existe. */
  readUserConfig(name: string): Promise<string | null>;
  writeUserConfig(name: string, text: string): Promise<string>;
  /** Copia el PDF del perfil a `publish.dir`. */
  publish(profile: string): Promise<Published>;
  /** Devuelve la función que deja de escuchar. */
  onBuildEvent(cb: (e: BuildEvent) => void): Promise<() => void>;
  /** `permitir` decide si se cierra la ventana (por ejemplo, si hay pestañas sin guardar). */
  onCloseRequested(permitir: () => Promise<boolean>): Promise<() => void>;
  exitApp(): Promise<void>;
  // Sólo para los smokes de aceptación (`LV_SMOKE`): el core los rechaza si no está esa variable.
  smokeReadBytes(rel: string): Promise<Uint8Array>;
  smokeMtime(rel: string): Promise<number>;
  writeSmokeResult(json: string): Promise<void>;
}
