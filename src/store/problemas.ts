// Lógica pura de la lista de problemas: filtrar, ordenar para F8 y sacar las marcas de un archivo. Sin React, sin
// CodeMirror y sin Tauri, para poder probarla.
import type { Problema, Simbolos } from '../backend';

export interface FiltroProblemas {
  errores: boolean;
  avisos: boolean;
  /** Overfull y Underfull: son tantas que arrancan apagadas. */
  badboxes: boolean;
  /** Lo que el lint encuentra sin compilar (etiquetas rotas, entornos sin cerrar). */
  lint: boolean;
  texto: string;
}

export const FILTRO_INICIAL: FiltroProblemas = { errores: true, avisos: true, badboxes: false, lint: true, texto: '' };

export const esLint = (p: Problema): boolean => p.kind.startsWith('lint-');

/** Los del último build y, después, los del lint. */
export const listaDeProblemas = (build: Problema[], simbolos: Simbolos | null): Problema[] => (simbolos?.lint.length ? [...build, ...simbolos.lint] : build);

/** Los que se ven en el panel, en el orden del log (el de aparición). */
export function visibles(todos: Problema[], f: FiltroProblemas): Problema[] {
  const texto = f.texto.trim().toLowerCase();
  return todos.filter((p) => {
    if (p.severity === 'error' && !f.errores) return false;
    if (p.severity === 'warning' && !f.avisos) return false;
    if (p.severity === 'badbox' && !f.badboxes) return false;
    if (esLint(p) && !f.lint) return false;
    if (!texto) return true;
    return `${p.message} ${p.file ?? ''} ${p.kind}`.toLowerCase().includes(texto);
  });
}

/** Con lo que F8 puede saltar: los que tienen archivo y línea. */
export const navegables = (lista: Problema[]): Problema[] => lista.filter((p) => p.file !== null && p.line !== null);

/** El índice (dentro de `lista`) del siguiente problema a visitar, dando la vuelta; `-1` si no hay ninguno navegable. */
export function siguiente(lista: Problema[], actual: number, dir: 1 | -1): number {
  const n = lista.length;
  for (let k = 1; k <= n; k++) {
    const i = (((actual + dir * k) % n) + n) % n;
    if (lista[i].file !== null && lista[i].line !== null) return i;
  }
  return -1;
}

export interface Marca {
  severity: Problema['severity'];
  /** Primera línea (1..N). */
  line: number;
  /** Última línea del rango, si lo hay. */
  lineEnd: number;
  message: string;
  /** Viene del lint y no del build: se dibuja distinto. */
  lint: boolean;
}

/** Las marcas de un archivo para el gutter y el subrayado. `visibles` ya viene filtrado: lo que no se ve en el panel no se marca. */
export function marcasDe(lista: Problema[], rel: string): Marca[] {
  return lista
    .filter((p) => p.file === rel && p.line !== null)
    .map((p) => ({ severity: p.severity, line: p.line as number, lineEnd: Math.max(p.line as number, p.line_end ?? (p.line as number)), message: p.message, lint: esLint(p) }));
}

export const ORDEN: Record<Problema['severity'], number> = { error: 0, warning: 1, badbox: 2 };

/** "2 errores · 3 avisos" (y las cajas mal llenas, si hay). Vacío si no hay nada. */
export function resumen(errores: number, avisos: number, badboxes: number): string {
  const partes: string[] = [];
  if (errores) partes.push(`${errores} error${errores === 1 ? '' : 'es'}`);
  if (avisos) partes.push(`${avisos} aviso${avisos === 1 ? '' : 's'}`);
  if (badboxes) partes.push(`${badboxes} caja${badboxes === 1 ? '' : 's'} mal llena${badboxes === 1 ? '' : 's'}`);
  return partes.join(' · ');
}
