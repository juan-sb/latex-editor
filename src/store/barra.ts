// El texto de la barra mientras compila (F8b): qué perfil, qué partes, en qué pasada y con qué herramienta, qué figura está cocinando
// pgf adentro y cuánto va contra lo típico. Funciones puras: se prueban sin React.
import type { Tipico } from '../backend';

/** La regla de latexmk que está corriendo: `n` es la vez de esa herramienta en este build (la pasada 2 de `pdflatex`). */
export interface PasoDeBuild {
  tool: string;
  n: number;
}

/** La figura que pgf lanzó adentro del build: la `n`-ésima y su nombre sin carpeta. */
export interface FiguraDeBuild {
  n: number;
  nombre: string;
}

const MOTORES = ['pdflatex', 'xelatex', 'lualatex'];

/** «pasada 2 · pdflatex» para el motor, «biber» o «makeindex 2» para el resto (una sola vez no lleva número). */
export function textoDePaso(p: PasoDeBuild | null): string {
  if (!p) return '';
  if (MOTORES.includes(p.tool)) return `pasada ${p.n} · ${p.tool}`;
  return p.n > 1 ? `${p.tool} ${p.n}` : p.tool;
}

/** `C7C9E7-butter-2` -> `butter-2`: el sello no le dice nada a quien mira la barra. */
export function nombreDeFigura(nombre: string): string {
  return (nombre.split('/').pop() ?? nombre).replace(/^[0-9A-F]{6}-/, '');
}

export function textoDeFigura(f: FiguraDeBuild | null): string {
  return f ? `cocinando figura ${f.n}: ${nombreDeFigura(f.nombre)}` : '';
}

/** «típico 28 s» (o «típico 1 min 05 s»), y si ya se pasó por mucho, que se note. */
export function textoDeTipico(t: Tipico | undefined, seg: number): string {
  if (!t || t.ms <= 0) return '';
  const base = `típico ${duracionCorta(t.ms / 1000)}`;
  return seg > (t.ms / 1000) * 1.5 + 5 ? `${base} · más lento que lo típico` : base;
}

export function duracionCorta(seg: number): string {
  const s = Math.round(seg);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** La línea de estado de un build en curso, sin el tiempo (que corre solo): perfil, partes, paso y figura, en ese orden. */
export function lineaDeBuild(o: { perfil: string; partes: string; paso: PasoDeBuild | null; figura: FiguraDeBuild | null }): string {
  return [`Compilando «${o.perfil}»`, o.partes, textoDePaso(o.paso), textoDeFigura(o.figura)].filter(Boolean).join(' · ');
}
