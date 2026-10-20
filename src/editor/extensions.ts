// Extensiones de CodeMirror para un documento LaTeX. Todo lo que cambia el aspecto usa variables CSS, así el tema
// claro y el oscuro de la interfaz alcanzan al editor sin tocar nada acá.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { extensionAutocompletar, type FuenteDeSimbolos } from './autocompletar';
import { extensionProblemas } from './problemas';

/**
 * La gramática de LaTeX. En F1 es el modo `stex` de `@codemirror/legacy-modes`; la definitiva (que sepa si el cursor
 * está en modo matemático y dentro de qué entorno) se evalúa en F5 y se cambia acá, en un solo lugar.
 */
export function latexLanguage(): Extension {
  return StreamLanguage.define(stex);
}

const resaltado = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-comando)' },
  { tag: t.comment, color: 'var(--syn-comentario)', fontStyle: 'italic' },
  { tag: [t.tagName, t.atom], color: 'var(--syn-entorno)' },
  { tag: [t.bracket, t.operator], color: 'var(--syn-signo)' },
  { tag: [t.number, t.string], color: 'var(--syn-valor)' },
  { tag: [t.variableName, t.meta], color: 'var(--syn-variable)' },
]);

const tema = EditorView.theme({
  '&': { height: '100%', color: 'var(--ed-texto)', backgroundColor: 'var(--ed-fondo)' },
  '.cm-scroller': { fontFamily: 'var(--fuente-mono)', fontSize: '13.5px', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--ed-cursor)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-cursor)' },
  // La selección se dibuja en una capa DETRÁS del texto (`drawSelection`). Tiene que ganarle al color de CodeMirror: el suyo con foco
  // (`&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`, #d7d4f0) es más específico que cualquier regla
  // de este tema y, como el tema oscuro de la app sale de `prefers-color-scheme` y CodeMirror cree que siempre es claro, sobre el
  // fondo oscuro quedaba un bloque casi blanco con el texto claro encima: ilegible. Por eso el `!important`.
  '.cm-selectionBackground': { backgroundColor: 'var(--ed-seleccion-inactiva) !important' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--ed-seleccion) !important' },
  '.cm-content ::selection': { backgroundColor: 'var(--ed-seleccion)' },
  '.cm-gutters': { backgroundColor: 'var(--ed-gutter)', color: 'var(--ed-gutter-texto)', border: 'none' },
  // La línea activa va SOBRE la capa de la selección: si fuera opaca la tapaba (cada párrafo del libro es una sola línea, así que
  // seleccionar un párrafo no se veía). Con transparencia la selección se ve a través.
  '.cm-activeLine': { backgroundColor: 'var(--ed-linea-activa)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--ed-linea-activa)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--ed-par)', outline: '1px solid var(--ed-par-borde)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--texto)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-busqueda)' },
});

// El editor no importa el store (el store importa el editor): lo que necesita de él entra por estos ganchos.
let fuenteSimbolos: FuenteDeSimbolos = () => null;
let alClicDefinicion: () => void = () => {};

/** De dónde saca el autocompletado el índice del proyecto. */
export function setFuenteSimbolos(f: FuenteDeSimbolos): void {
  fuenteSimbolos = f;
}

/** Qué hace Ctrl+clic (ir a la definición de lo que hay bajo el cursor). */
export function setManejadorDefinicion(f: () => void): void {
  alClicDefinicion = f;
}

/** Ctrl+clic: CodeMirror lo usa para agregar un cursor; acá es "ir a la definición" (el multicursor sigue con Alt+clic). */
const ctrlClic = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return false;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    alClicDefinicion();
    return true;
  },
});

/** Soft wrap por defecto: cada párrafo del libro es una sola línea de hasta ~500 caracteres. */
export function extensionesBase(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    latexLanguage(),
    syntaxHighlighting(resaltado),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    extensionProblemas(),
    extensionAutocompletar(() => fuenteSimbolos()),
    ctrlClic,
    tema,
  ];
}
