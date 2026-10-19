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
    }
  | { type: 'error'; message: string };

export interface LaunchOptions {
  open: string | null;
  root: string | null;
  smoke: boolean;
  /** Qué smoke de aceptación corre la interfaz con `LV_SMOKE`: el de F1 o el de F2. */
  smokeMode: 'f1' | 'f2';
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
