// Registro de los documentos abiertos. Cada uno es un `EditorState` de CodeMirror y es la ÚNICA copia del texto: no hay
// otra autoritativa en el store ni en el core, y eso deja lugar para Yjs más adelante (11 del plan). Zustand sólo guarda
// metadatos de las pestañas; con documentos de 200 KB, tenerlos en el store re-renderizaría todo en cada tecla.
import { openSearchPanel } from '@codemirror/search';
import { EditorState, Text, type ChangeSpec, type StateEffect, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Eol, FileRead, Problema } from '../backend';
import { marcasDe } from '../store/problemas';
import { extensionesBase } from './extensions';
import { setProblemas } from './problemas';

export interface DocEntry {
  rel: string;
  /** Siempre el último estado: lo actualiza el listener en cada transacción de la vista. */
  state: EditorState;
  /** El documento tal como está en disco, para saber si hay cambios sin guardar. */
  saved: Text;
  version: string;
  eol: Eol;
  bom: boolean;
  mixed: boolean;
  readOnly: boolean;
  /** Posición de scroll al salir de la pestaña (`setState` no la conserva). */
  scroll: StateEffect<unknown> | null;
}

const docs = new Map<string, DocEntry>();
let alCambiarDirty: (rel: string, dirty: boolean) => void = () => {};

/** El store se entera de los cambios de "modificado" por acá. */
export function setDirtyListener(fn: (rel: string, dirty: boolean) => void): void {
  alCambiarDirty = fn;
}

let alEditar: (rel: string) => void = () => {};
let alMoverSeleccion: (rel: string) => void = () => {};

/** El store se entera de cada cambio de selección o de cursor por acá ("seguir al cursor" de SyncTeX). */
export function setSelectionListener(fn: (rel: string) => void): void {
  alMoverSeleccion = fn;
}

/** El store se entera de cada edición por acá (el autoguardado "al dejar de tipear" la usa). */
export function setEditListener(fn: (rel: string) => void): void {
  alEditar = fn;
}

export const estaModificado = (e: DocEntry): boolean => !e.state.doc.eq(e.saved);

function construirEstado(entry: DocEntry, doc: string | Text, selection?: EditorState['selection']): EditorState {
  const oyente = EditorView.updateListener.of((u) => {
    const antes = estaModificado(entry);
    entry.state = u.state;
    if (u.docChanged && estaModificado(entry) !== antes) alCambiarDirty(entry.rel, estaModificado(entry));
    if (u.docChanged) alEditar(entry.rel);
    if (u.selectionSet) alMoverSeleccion(entry.rel);
  });
  return EditorState.create({
    doc,
    selection,
    extensions: [
      ...extensionesBase(),
      oyente,
      // Los archivos con EOL mezclados se abren en sólo lectura: el editor sólo conoce el texto normalizado y guardarlo
      // alteraría líneas que el usuario no tocó (10.2 del plan).
      ...(entry.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });
}

export function crearDoc(rel: string, r: FileRead): DocEntry {
  const entry = { rel, version: r.version, eol: r.eol, bom: r.bom, mixed: r.mixed, readOnly: r.mixed, scroll: null } as DocEntry;
  entry.state = construirEstado(entry, r.text);
  entry.saved = entry.state.doc;
  docs.set(rel, entry);
  aplicarProblemasA(entry);
  return entry;
}

export const getDoc = (rel: string): DocEntry | undefined => docs.get(rel);
export const cerrarDoc = (rel: string): void => void docs.delete(rel);
export const cerrarTodos = (): void => docs.clear();
export const textoDe = (rel: string): string | null => docs.get(rel)?.state.doc.toString() ?? null;

/** El usuario aceptó normalizar un archivo mezclado: pasa a editable, con el mismo texto y la misma selección. */
export function hacerEditable(rel: string): void {
  const e = docs.get(rel);
  if (!e || !e.readOnly) return;
  e.readOnly = false;
  e.state = construirEstado(e, e.state.doc, e.state.selection);
  aplicarProblemasA(e);
}

/** Registra que `texto` (la versión `doc` del documento) ya está en disco con `version`. */
export function marcarGuardado(rel: string, doc: Text, version: string): void {
  const e = docs.get(rel);
  if (!e) return;
  const antes = estaModificado(e);
  e.saved = doc;
  e.version = version;
  if (estaModificado(e) !== antes) alCambiarDirty(rel, estaModificado(e));
}

// --- vista activa -----------------------------------------------------------------------------------------------------

let vistaActiva: { rel: string; view: EditorView } | null = null;

export function registrarVista(v: { rel: string; view: EditorView } | null): void {
  vistaActiva = v;
}

/**
 * Aplica a la vista activa lo que arma `f` sobre su estado (formato, comentar...). `false` si no hay vista, el documento es de
 * sólo lectura o `f` no tiene nada que hacer; el listener de la vista actualiza el estado guardado.
 */
export function aplicarEnVista(f: (state: EditorState) => TransactionSpec | null): boolean {
  if (!vistaActiva || vistaActiva.view.state.readOnly) return false;
  const spec = f(vistaActiva.view.state);
  if (!spec) return false;
  vistaActiva.view.dispatch(spec);
  return true;
}

/** Abre el panel de buscar (y reemplazar) de CodeMirror en el archivo actual. */
export function abrirBusquedaEnArchivo(): boolean {
  if (!vistaActiva) return false;
  vistaActiva.view.focus();
  return openSearchPanel(vistaActiva.view);
}

/**
 * Aplica un cambio al documento. Si está en la vista se despacha ahí (el listener actualiza el estado); si no, se
 * aplica sobre el estado y se recalcula "modificado" a mano. Lo usan el smoke y los tests.
 */
export function editarDoc(rel: string, changes: ChangeSpec): void {
  const e = docs.get(rel);
  if (!e) throw new Error(`el documento ${rel} no está abierto`);
  if (vistaActiva && vistaActiva.rel === rel) {
    vistaActiva.view.dispatch({ changes });
    return;
  }
  const antes = estaModificado(e);
  e.state = e.state.update({ changes }).state;
  if (estaModificado(e) !== antes) alCambiarDirty(rel, estaModificado(e));
}


// --- problemas del último build -------------------------------------------------------------------------------------

/** Los problemas que se marcan ahora (ya filtrados por lo que el panel muestra). */
let problemasVigentes: Problema[] = [];

function aplicarProblemasA(e: DocEntry): void {
  const efecto = setProblemas.of(marcasDe(problemasVigentes, e.rel));
  if (vistaActiva && vistaActiva.rel === e.rel) vistaActiva.view.dispatch({ effects: efecto });
  else e.state = e.state.update({ effects: efecto }).state;
}

/** Marca los problemas en todos los documentos abiertos (y en los que se abran después). */
export function aplicarProblemas(lista: Problema[]): void {
  problemasVigentes = lista;
  docs.forEach(aplicarProblemasA);
}

/** Mueve el cursor (como lo haría el usuario): por la vista si el documento está en ella, y si no, sobre el estado guardado. */
export function moverCursor(rel: string, anchor: number, head?: number): void {
  const e = docs.get(rel);
  if (!e) throw new Error(`el documento ${rel} no está abierto`);
  if (vistaActiva && vistaActiva.rel === rel) {
    vistaActiva.view.dispatch({ selection: { anchor, head } });
    return;
  }
  e.state = e.state.update({ selection: { anchor, head } }).state;
}

/** Escribe `texto` en el cursor de la vista activa como si se tecleara (dispara el autocompletado). Lo usa el smoke. */
export function escribirComoTecleado(texto: string): void {
  if (!vistaActiva) throw new Error('no hay una vista activa');
  const v = vistaActiva.view;
  const { from, to } = v.state.selection.main;
  v.dispatch({ changes: { from, to, insert: texto }, selection: { anchor: from + texto.length }, userEvent: 'input.type' });
}

/** El elemento editable de la vista activa (para mandarle teclas reales en el smoke). */
export const contenidoDeVista = (): HTMLElement | null => vistaActiva?.view.contentDOM ?? null;
