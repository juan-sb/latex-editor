// Marcas de problemas en el editor: un marcador en el gutter y la línea subrayada, por severidad. Las marcas viven en un
// StateField, así que cada pestaña (cada `EditorState`) lleva las suyas y las posiciones se mueven solas con las ediciones:
// si se inserta una línea arriba, el marcador baja con la línea a la que apuntaba.
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import { ORDEN, type Marca } from '../store/problemas';

export const setProblemas = StateEffect.define<Marca[]>();

class Marcador extends GutterMarker {
  constructor(
    readonly severity: Marca['severity'],
    readonly texto: string,
    readonly lint = false,
  ) {
    super();
  }

  eq(otro: GutterMarker): boolean {
    return otro instanceof Marcador && otro.severity === this.severity && otro.texto === this.texto && otro.lint === this.lint;
  }

  toDOM(): Node {
    const el = document.createElement('span');
    el.className = `lv-marca ${this.severity}${this.lint ? ' lint' : ''}`;
    el.textContent = this.lint ? '◆' : this.severity === 'error' ? '●' : this.severity === 'warning' ? '▲' : '○';
    el.title = this.texto;
    return el;
  }
}

interface Estado {
  deco: DecorationSet;
  marcadores: RangeSet<GutterMarker>;
}

const VACIO: Estado = { deco: Decoration.none, marcadores: RangeSet.empty };

function construir(doc: { lines: number; line(n: number): { from: number } }, marcas: Marca[]): Estado {
  const decos: { from: number; value: Decoration }[] = [];
  const marcadores: { from: number; value: GutterMarker }[] = [];
  // Una línea con varios problemas lleva el más grave en el gutter; el subrayado es el de ese mismo.
  const porLinea = new Map<number, Marca>();
  for (const m of marcas) {
    for (let l = Math.min(m.line, doc.lines); l <= Math.min(m.lineEnd, doc.lines); l++) {
      const previa = porLinea.get(l);
      if (!previa || ORDEN[m.severity] < ORDEN[previa.severity]) porLinea.set(l, m);
    }
  }
  for (const [l, m] of porLinea) {
    const from = doc.line(l).from;
    decos.push({ from, value: Decoration.line({ class: `lv-linea-${m.severity}${m.lint ? ' lv-linea-lint' : ''}`, attributes: { title: m.message } }) });
    // El marcador va sólo en la primera línea del rango: un overfull de 40 líneas no llena el gutter.
    if (l === Math.min(m.line, doc.lines)) marcadores.push({ from, value: new Marcador(m.severity, m.message, m.lint) });
  }
  const orden = (a: { from: number }, b: { from: number }) => a.from - b.from;
  return {
    deco: Decoration.set(decos.sort(orden).map((d) => d.value.range(d.from))),
    marcadores: RangeSet.of(marcadores.sort(orden).map((d) => d.value.range(d.from))),
  };
}

const campo = StateField.define<Estado>({
  create: () => VACIO,
  update(valor, tr) {
    for (const e of tr.effects) if (e.is(setProblemas)) return construir(tr.state.doc, e.value);
    if (!tr.docChanged) return valor;
    return { deco: valor.deco.map(tr.changes), marcadores: valor.marcadores.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const tema = EditorView.baseTheme({
  '.cm-gutter.cm-lv-problemas': { width: '16px' },
  '.lv-marca': { cursor: 'default', fontSize: '10px', display: 'block', textAlign: 'center' },
  '.lv-marca.error': { color: 'var(--peligro)' },
  '.lv-marca.warning': { color: 'var(--aviso)' },
  '.lv-marca.badbox': { color: 'var(--texto-suave)' },
  '.lv-linea-error': { backgroundImage: 'linear-gradient(var(--peligro), var(--peligro))', backgroundSize: '100% 2px', backgroundRepeat: 'no-repeat', backgroundPosition: '0 100%', backgroundColor: 'var(--fondo-error)' },
  '.lv-linea-warning': { backgroundImage: 'linear-gradient(var(--aviso), var(--aviso))', backgroundSize: '100% 1px', backgroundRepeat: 'no-repeat', backgroundPosition: '0 100%', backgroundColor: 'var(--fondo-aviso)' },
  '.lv-linea-lint': { backgroundImage: 'none', textDecoration: 'underline dotted var(--aviso)', textUnderlineOffset: '3px' },
  '.lv-linea-badbox': { backgroundColor: 'var(--fondo-badbox)' },
});

export function extensionProblemas(): Extension {
  return [campo, gutter({ class: 'cm-lv-problemas', markers: (v) => v.state.field(campo).marcadores, initialSpacer: () => new Marcador('badbox', '') }), tema];
}

/** Las marcas que lleva un estado, de la primera a la última línea marcada (para las pruebas y para F8 dentro del archivo). */
export function lineasMarcadas(state: EditorState): number[] {
  const out: number[] = [];
  const it = state.field(campo).marcadores.iter();
  while (it.value) {
    out.push(state.doc.lineAt(it.from).number);
    it.next();
  }
  return out;
}

