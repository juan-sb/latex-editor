// Autocompletado (10.2 del plan): comandos (base + los del proyecto), entornos tras `\begin{` con su `\end{}`, etiquetas tras
// `\ref{`, claves tras `\cite{` con autor y título, y rutas tras `\input{` / `\includegraphics{`. Las fuentes son funciones puras de
// un `CompletionContext` y los símbolos del proyecto, así se prueban sin vista.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { Simbolos } from '../backend';
import { COMANDOS_BASE, ENTORNOS_BASE } from './latexComandos';

const REFS = String.raw`(?:ref|eqref|cref|Cref|pageref|autoref|nameref|vref)`;
const CITAS = String.raw`(?:cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite|fullcite|smartcite|supercite)`;
const RUTAS = String.raw`(input|include|includeonly|subfile|import|includegraphics|addbibresource|bibliography)`;

const RE_REF = new RegExp(String.raw`\\${REFS}\*?\{([^{}]*)$`);
const RE_CITA = new RegExp(String.raw`\\${CITAS}\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$`);
const RE_ENTORNO = /\\(begin|end)\{([^{}]*)$/;
const RE_RUTA = new RegExp(String.raw`\\${RUTAS}\*?(?:\[[^\]]*\])?\{([^{}]*)$`);
const RE_COMANDO = /(?<![\\A-Za-z])\\([A-Za-z]*)$/;

/** Lo que va después de la última coma del argumento (varias claves en un `\cite{a,b}`), y dónde empieza en el documento. */
function ultimoTrozo(arg: string, pos: number): { from: number; prefijo: string } {
  const k = arg.lastIndexOf(',');
  const crudo = arg.slice(k + 1);
  const espacios = crudo.length - crudo.trimStart().length;
  return { from: pos - crudo.length + espacios, prefijo: crudo.trimStart() };
}

/** El entorno de la última `\begin` sin su `\end` en `texto`: es el que más probablemente se quiere cerrar. */
export function entornoAbierto(texto: string): string | null {
  const pila: string[] = [];
  for (const m of texto.matchAll(/\\(begin|end)\{([^{}]*)\}/g)) {
    if (m[1] === 'begin') pila.push(m[2]);
    else if (pila[pila.length - 1] === m[2]) pila.pop();
    else {
      const k = pila.lastIndexOf(m[2]);
      if (k >= 0) pila.length = k;
    }
  }
  return pila[pila.length - 1] ?? null;
}

/** El texto que se inserta al elegir un entorno tras `\begin{`: el nombre, la llave, un renglón de adentro y el `\end{}`. */
export function textoDeEntorno(nombre: string): { insert: string; cursor: number } {
  const insert = `${nombre}}\n  \n\\end{${nombre}}`;
  return { insert, cursor: nombre.length + 1 + 1 + 2 };
}

const recortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unicos = <T,>(xs: T[], clave: (x: T) => string): T[] => {
  const vistos = new Set<string>();
  return xs.filter((x) => (vistos.has(clave(x)) ? false : (vistos.add(clave(x)), true)));
};

export type FuenteDeSimbolos = () => Simbolos | null;

/** Una fuente de CodeMirror que mira lo que hay antes del cursor en la línea y ofrece lo que corresponde. */
export function crearFuente(simbolos: FuenteDeSimbolos) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const linea = ctx.state.doc.lineAt(ctx.pos);
    const antes = linea.text.slice(0, ctx.pos - linea.from);
    const s = simbolos();
    let m: RegExpExecArray | null;

    if ((m = RE_REF.exec(antes))) {
      const { from } = ultimoTrozo(m[1], ctx.pos);
      const opciones: Completion[] = unicos(s?.labels ?? [], (l) => l.name).map((l) => ({
        label: l.name,
        detail: recortar(l.context, 64),
        info: `${l.file}:${l.line}`,
        type: 'variable',
      }));
      return { from, options: opciones, validFor: /^[\w:.\-+*/]*$/ };
    }

    if ((m = RE_CITA.exec(antes))) {
      const { from } = ultimoTrozo(m[1], ctx.pos);
      const opciones: Completion[] = unicos(s?.bib ?? [], (b) => b.key).map((b) => ({
        label: b.key,
        detail: recortar(`${b.author.split(' and ')[0]}${b.year ? ` (${b.year})` : ''}`, 48),
        info: b.title || undefined,
        type: 'text',
      }));
      return { from, options: opciones, validFor: /^[\w:.\-+/]*$/ };
    }

    if ((m = RE_ENTORNO.exec(antes))) {
      const from = ctx.pos - m[2].length;
      const nombres = unicos([...ENTORNOS_BASE, ...(s?.defs ?? []).filter((d) => ['environment', 'theorem', 'tcolorbox'].includes(d.kind)).map((d) => d.name)], (x) => x);
      const abierto = m[1] === 'end' ? entornoAbierto(ctx.state.doc.sliceString(0, linea.from) + antes.slice(0, antes.length - m[0].length)) : null;
      const sigue = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 1) === '}' ? 1 : 0;
      const opciones: Completion[] = nombres.map((nombre) => {
        if (m![1] === 'end') {
          return { label: nombre, type: 'keyword', boost: nombre === abierto ? 99 : 0, apply: (view, _c, de, hasta) => view.dispatch({ changes: { from: de, to: hasta + sigue, insert: `${nombre}}` }, selection: { anchor: de + nombre.length + 1 } }) };
        }
        return {
          label: nombre,
          type: 'keyword',
          apply: (view, _c, de, hasta) => {
            const t = textoDeEntorno(nombre);
            view.dispatch({ changes: { from: de, to: hasta + sigue, insert: t.insert }, selection: { anchor: de + t.cursor } });
          },
        };
      });
      return { from, options: opciones, validFor: /^[A-Za-z*]*$/ };
    }

    if ((m = RE_RUTA.exec(antes))) {
      const cmd = m[1];
      const from = ctx.pos - m[2].length;
      const archivos = s?.files ?? [];
      let opciones: Completion[];
      if (cmd === 'includegraphics') {
        opciones = archivos.filter((f) => f.kind === 'image').map((f) => ({ label: f.rel, type: 'file' }));
      } else if (cmd === 'addbibresource') {
        opciones = archivos.filter((f) => f.kind === 'bib').map((f) => ({ label: f.rel, type: 'file' }));
      } else if (cmd === 'bibliography') {
        opciones = archivos.filter((f) => f.kind === 'bib').map((f) => ({ label: f.rel.replace(/\.bib$/i, ''), type: 'file' }));
      } else {
        opciones = archivos.filter((f) => f.kind === 'tex').map((f) => ({ label: f.rel.replace(/\.tex$/i, ''), type: 'file' }));
      }
      return { from, options: opciones, validFor: /^[^{}]*$/ };
    }

    if ((m = RE_COMANDO.exec(antes)) && (m[1].length > 0 || ctx.explicit)) {
      const from = ctx.pos - m[1].length;
      const delProyecto = unicos((s?.defs ?? []).filter((d) => ['command', 'operator', 'def'].includes(d.kind)), (d) => d.name);
      const opciones: Completion[] = [
        ...delProyecto.map((d): Completion => ({ label: d.name, type: 'function', detail: d.args ? `${d.args} arg.` : 'proyecto', info: `${d.file}:${d.line}`, boost: 1 })),
        ...unicos(COMANDOS_BASE, (x) => x).filter((c) => !delProyecto.some((d) => d.name === c)).map((c): Completion => ({ label: c, type: 'function' })),
      ];
      return { from, options: opciones, validFor: /^[A-Za-z]*$/ };
    }
    return null;
  };
}

/** La extensión: el menú de CodeMirror con la fuente de LaTeX. `simbolos` se pide en cada uso, así siempre ve los últimos. */
export function extensionAutocompletar(simbolos: FuenteDeSimbolos): Extension {
  return autocompletion({ override: [crearFuente(simbolos)], icons: false, activateOnTyping: true, maxRenderedOptions: 60 });
}
