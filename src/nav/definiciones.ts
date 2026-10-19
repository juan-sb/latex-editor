// Ir a la definición y dónde se usa (10.2 del plan): qué hay bajo el cursor y a dónde lleva. Lógica pura sobre una línea de
// texto y los símbolos del proyecto, sin CodeMirror ni Tauri.
import type { Simbolos } from '../backend';

export type TipoToken = 'ref' | 'cite' | 'label' | 'input' | 'graphics' | 'bib' | 'entorno' | 'comando';

export interface Token {
  tipo: TipoToken;
  /** La clave, la ruta o el nombre del comando (sin la barra). */
  nombre: string;
  /** Posición en la línea del nombre. */
  inicio: number;
  fin: number;
  /** El comando que lo rodea (`ref`, `cite`, `input`...), si el token es un argumento. */
  comando?: string;
}

const REFS = new Set(['ref', 'eqref', 'cref', 'Cref', 'pageref', 'autoref', 'nameref', 'vref', 'labelcref', 'cpageref']);
const CITAS = new Set(['cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'nocite', 'fullcite', 'smartcite', 'supercite']);
const ENTRADAS = new Set(['input', 'include', 'subfile', 'import', 'subimport']);
const BIBS = new Set(['bibliography', 'addbibresource']);

/** Lo que hay bajo la columna `col` de una línea: un argumento de `\ref`, `\cite`, `\input`..., o un comando. `null` si nada. */
export function tokenEnCursor(linea: string, col: number): Token | null {
  // Un comando con su argumento entre llaves: `\cmd*[opc]{arg}`.
  const re = /\\([A-Za-z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/g;
  for (const m of linea.matchAll(re)) {
    const ini = (m.index ?? 0) + m[0].length - m[2].length - 1;
    const fin = ini + m[2].length;
    if (col < ini || col > fin) continue;
    const cmd = m[1];
    // Varias claves separadas por coma: se elige la que contiene el cursor.
    let desde = ini;
    for (const trozo of m[2].split(',')) {
      const a = desde;
      const b = desde + trozo.length;
      desde = b + 1;
      if (col < a || col > b) continue;
      const nombre = trozo.trim();
      if (!nombre) return null;
      const corrido = trozo.length - trozo.trimStart().length;
      const t = { nombre, inicio: a + corrido, fin: a + corrido + nombre.length, comando: cmd };
      if (REFS.has(cmd)) return { tipo: 'ref', ...t };
      if (CITAS.has(cmd)) return { tipo: 'cite', ...t };
      if (cmd === 'label') return { tipo: 'label', ...t };
      if (ENTRADAS.has(cmd)) return { tipo: 'input', ...t };
      if (cmd === 'includegraphics') return { tipo: 'graphics', ...t };
      if (BIBS.has(cmd)) return { tipo: 'bib', ...t };
      if (cmd === 'begin' || cmd === 'end') return { tipo: 'entorno', ...t };
    }
  }
  // El nombre de un comando: `\foo` con el cursor adentro o al final.
  for (const m of linea.matchAll(/\\([A-Za-z]+)/g)) {
    const a = m.index ?? 0;
    if (col >= a && col <= a + m[0].length) return { tipo: 'comando', nombre: m[1], inicio: a + 1, fin: a + m[0].length };
  }
  return null;
}

export interface Destino {
  /** Archivo del proyecto (relativo a la raíz). */
  rel: string;
  line: number;
  /** Es una imagen: no se abre en el editor. */
  imagen?: boolean;
}

const sinExt = (p: string) => p.replace(/\.(tex|bib)$/i, '');

/** A dónde lleva un token (F12 / Ctrl+clic), o `null` si no hay definición en el proyecto. */
export function resolverDefinicion(t: Token, s: Simbolos): Destino | null {
  const igual = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  switch (t.tipo) {
    case 'ref': {
      const l = s.labels.find((x) => x.name === t.nombre);
      return l ? { rel: l.file, line: l.line } : null;
    }
    case 'cite': {
      const b = s.bib.find((x) => x.key === t.nombre);
      return b ? { rel: b.file, line: b.line } : null;
    }
    case 'input': {
      const f = s.files.find((x) => x.kind === 'tex' && (igual(x.rel, t.nombre) || igual(sinExt(x.rel), sinExt(t.nombre))));
      return f ? { rel: f.rel, line: 1 } : null;
    }
    case 'bib': {
      const f = s.files.find((x) => x.kind === 'bib' && (igual(x.rel, t.nombre) || igual(sinExt(x.rel), sinExt(t.nombre))));
      return f ? { rel: f.rel, line: 1 } : null;
    }
    case 'graphics': {
      const f = s.files.find((x) => x.kind === 'image' && (igual(x.rel, t.nombre) || igual(x.rel.replace(/\.[A-Za-z]+$/, ''), t.nombre)));
      return f ? { rel: f.rel, line: 1, imagen: true } : null;
    }
    case 'entorno': {
      const d = s.defs.find((x) => (x.kind === 'environment' || x.kind === 'theorem' || x.kind === 'tcolorbox') && x.name === t.nombre);
      return d ? { rel: d.file, line: d.line } : null;
    }
    case 'comando': {
      const d = s.defs.find((x) => (x.kind === 'command' || x.kind === 'operator' || x.kind === 'def') && x.name === t.nombre);
      return d ? { rel: d.file, line: d.line } : null;
    }
    case 'label':
      return null; // ya es la definición
  }
}

export interface UsoEnLista {
  file: string;
  line: number;
  /** El comando que lo usa (`ref`, `cite`...). */
  comando: string;
}

/** Dónde se usa lo que hay bajo el cursor (Shift+F12): una etiqueta (con o sin `\ref`) o una clave de cita. */
export function resolverUsos(t: Token, s: Simbolos): UsoEnLista[] {
  const de = (lista: { name: string; command: string; file: string; line: number }[]) =>
    lista.filter((u) => u.name === t.nombre).map((u) => ({ file: u.file, line: u.line, comando: u.command }));
  if (t.tipo === 'ref' || t.tipo === 'label') return de(s.refs);
  if (t.tipo === 'cite') return de(s.cites);
  return [];
}

/** Qué es lo que se busca cuando el cursor está en un token, para titular la lista. */
export function describir(t: Token): string {
  const que: Record<TipoToken, string> = { ref: 'la etiqueta', label: 'la etiqueta', cite: 'la clave', input: 'el archivo', graphics: 'la imagen', bib: 'la bibliografía', entorno: 'el entorno', comando: 'el comando' };
  return `${que[t.tipo]} ${t.tipo === 'comando' ? `\\${t.nombre}` : t.nombre}`;
}
