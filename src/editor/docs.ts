// Registro de los documentos abiertos. Cada uno es un `EditorState` de CodeMirror y es la ÚNICA copia del texto: no hay
// otra autoritativa en el store ni en el core, y eso deja lugar para Yjs más adelante (11 del plan). Zustand sólo guarda
// metadatos de las pestañas; con documentos de 200 KB, tenerlos en el store re-renderizaría todo en cada tecla.
import { EditorState, Text, type ChangeSpec, type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Eol, FileRead } from '../backend';
import { extensionesBase } from './extensions';

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

export const estaModificado = (e: DocEntry): boolean => !e.state.doc.eq(e.saved);

function construirEstado(entry: DocEntry, doc: string | Text, selection?: EditorState['selection']): EditorState {
  const oyente = EditorView.updateListener.of((u) => {
    const antes = estaModificado(entry);
    entry.state = u.state;
    if (u.docChanged && estaModificado(entry) !== antes) alCambiarDirty(entry.rel, estaModificado(entry));
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
