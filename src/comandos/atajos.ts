// Atajos de teclado (10.3 del plan): parseo de combinaciones ("Ctrl+Shift+T"), comparación con un evento del navegador y la
// mezcla de los atajos por defecto con el `keybindings.json` del usuario. Lógica pura, sin DOM ni Tauri.

export interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Minúscula; las teclas con nombre en su forma de `KeyboardEvent.key` (`enter`, `arrowleft`, `f8`, `tab`). */
  tecla: string;
}

const ALIAS: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  space: ' ',
  espacio: ' ',
  del: 'delete',
  plus: '+',
  more: '+',
  menos: '-',
  barra: '/',
  mas: '+',
};

const MODIFICADORES = new Set(['ctrl', 'control', 'cmd', 'meta', 'mod', 'shift', 'mayus', 'alt', 'opt', 'option']);

/** "Ctrl+Shift+T" a un `Combo`; `null` si no se entiende (sin tecla, o con más de una). */
export function parseAtajo(texto: string): Combo | null {
  // El signo `+` es a la vez separador y tecla ("Ctrl++"): se lo reconoce al final.
  const partes = texto.trim().length > 1 && texto.trim().endsWith('++') ? [...texto.trim().slice(0, -2).split('+'), '+'] : texto.split('+');
  const combo: Combo = { ctrl: false, shift: false, alt: false, tecla: '' };
  for (const crudo of partes) {
    const p = crudo.trim().toLowerCase();
    if (!p) return null;
    if (p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'meta' || p === 'mod') combo.ctrl = true;
    else if (p === 'shift' || p === 'mayus') combo.shift = true;
    else if (p === 'alt' || p === 'opt' || p === 'option') combo.alt = true;
    else if (MODIFICADORES.has(p) || combo.tecla) return null;
    else combo.tecla = ALIAS[p] ?? p;
  }
  return combo.tecla ? combo : null;
}

export function formatoAtajo(c: Combo): string {
  const nombres: Record<string, string> = { enter: 'Enter', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', tab: 'Tab', escape: 'Esc', ' ': 'Espacio' };
  const t = nombres[c.tecla] ?? (c.tecla.length === 1 ? c.tecla.toUpperCase() : c.tecla.toUpperCase());
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Mayús', t].filter(Boolean).join('+');
}

const esSimbolo = (t: string) => t.length === 1 && !/[a-z0-9]/.test(t);

/** La tecla de un evento, en la misma forma que `Combo.tecla`. */
function teclaDe(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  // Las letras se toman del código físico: con Shift o con un teclado de otro idioma `key` cambia. Los dígitos y los símbolos,
  // de `key`: `/` en un teclado en español es Shift+7 y su código es el del 7.
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

/**
 * ¿El evento es esta combinación? Con una tecla de símbolo (`/`, `\`, `=`) el Shift no cuenta: en un teclado en español
 * `/` se escribe con Shift+7, y el atajo "Ctrl+/" tiene que andar igual.
 */
export function coincide(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, c: Combo): boolean {
  if ((e.ctrlKey || e.metaKey) !== c.ctrl || e.altKey !== c.alt) return false;
  const t = teclaDe(e);
  if (t !== c.tecla) return false;
  return esSimbolo(c.tecla) ? true : e.shiftKey === c.shift;
}

export function mismoCombo(a: Combo, b: Combo): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.tecla === b.tecla && (esSimbolo(a.tecla) || a.shift === b.shift);
}

export type AtajosPorId = Record<string, string[]>;

export interface AtajosResueltos {
  /** Combinaciones de cada comando, ya parseadas. */
  porId: Map<string, Combo[]>;
  /** Cosas del `keybindings.json` que no se pudieron aplicar (para mostrarlas, no para romper). */
  avisos: string[];
}

/**
 * Mezcla los atajos por defecto con los del usuario. El `keybindings.json` es `{ "id": "Ctrl+Alt+B" }`, `{ "id": ["A", "B"] }`
 * o `{ "id": null }` para quitarle el atajo a un comando. Lo que no se entiende se avisa y se ignora. Dos comandos con la
 * misma combinación se avisan: gana el primero en el orden de `defaults`.
 */
export function resolverAtajos(defaults: AtajosPorId, usuario: unknown): AtajosResueltos {
  const avisos: string[] = [];
  const efectivos: AtajosPorId = {};
  for (const [id, a] of Object.entries(defaults)) efectivos[id] = [...a];
  if (usuario !== null && usuario !== undefined) {
    if (typeof usuario !== 'object' || Array.isArray(usuario)) {
      avisos.push('keybindings.json tiene que ser un objeto { "comando": "Ctrl+X" }');
    } else {
      for (const [id, valor] of Object.entries(usuario as Record<string, unknown>)) {
        if (!(id in defaults)) {
          avisos.push(`keybindings.json: no existe el comando «${id}»`);
          continue;
        }
        const lista = valor === null ? [] : Array.isArray(valor) ? valor : [valor];
        const buenos = lista.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
        if (buenos.length !== lista.length) avisos.push(`keybindings.json: «${id}» tiene que ser un texto, una lista de textos o null`);
        efectivos[id] = buenos;
      }
    }
  }
  const porId = new Map<string, Combo[]>();
  const dueno: { combo: Combo; id: string }[] = [];
  for (const [id, textos] of Object.entries(efectivos)) {
    const combos: Combo[] = [];
    for (const t of textos) {
      const c = parseAtajo(t);
      if (!c) {
        avisos.push(`el atajo «${t}» de «${id}» no se entiende`);
        continue;
      }
      const choque = dueno.find((d) => mismoCombo(d.combo, c));
      if (choque && choque.id === id) continue; // un alias repetido ("Alt+Left" y "Alt+←"): es el mismo atajo
      if (choque) {
        avisos.push(`«${t}» está en «${choque.id}» y en «${id}»: gana «${choque.id}»`);
        continue;
      }
      dueno.push({ combo: c, id });
      combos.push(c);
    }
    porId.set(id, combos);
  }
  return { porId, avisos };
}

/** El comando que corresponde a un evento, o `undefined`. */
export function buscarPorEvento(r: AtajosResueltos, e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | undefined {
  for (const [id, combos] of r.porId) if (combos.some((c) => coincide(e, c))) return id;
  return undefined;
}

/** Atajos que el navegador usa por su cuenta y que dejarían la app rota (recargar pierde lo no guardado): se frenan siempre. */
export function esNativoPeligroso(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  return k === 'f5' || (ctrl && !e.altKey && (k === 'r' || k === 'p' || k === 'f' || k === 'g' || k === 'u' || k === 'j' || k === 'o' || k === 'n'));
}
