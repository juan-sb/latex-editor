// Lo que el panel Historial y el Doctor muestran, como funciones puras (se prueban sin React).
import type { EntradaHistorial, Hallazgo, NivelHallazgo } from '../backend';

export const NOMBRE_DE_TIPO: Record<EntradaHistorial['tipo'], string> = {
  build: 'Build',
  bake: 'Figuras',
  export: 'Exportar',
  fragment: 'Fragmento',
};

/** `12 s`, `1 min 05 s`, `850 ms`. */
export function duracion(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`;
}

export function hora(inicioMs: number): string {
  const d = new Date(inicioMs);
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

export type ResultadoDeTrabajo = 'ok' | 'fail' | 'cancelled';

export const resultado = (e: EntradaHistorial): ResultadoDeTrabajo => (e.cancelado ? 'cancelled' : e.ok ? 'ok' : 'fail');

/** El motivo para la tabla: `guardado: Cap/uno.tex` queda `guardado: uno.tex`; los demás tal cual. */
export function motivoCorto(motivo: string): string {
  const m = /^(guardado|afuera): (.*)$/.exec(motivo);
  if (!m) return motivo;
  const nombres = m[2].split(', ').map((r) => r.split('/').pop() ?? r);
  return `${m[1]}: ${nombres.join(', ')}`;
}

/** La columna «qué hizo»: lo más útil de cada tipo en una línea. */
export function resumen(e: EntradaHistorial): string {
  if (e.tipo === 'bake') {
    const partes = [`${e.cocidas ?? 0} cocida${e.cocidas === 1 ? '' : 's'}`];
    if (e.fallidas) partes.push(`${e.fallidas} fallida${e.fallidas === 1 ? '' : 's'}`);
    if (e.cedio) partes.push(`cedió el paso (quedaban ${e.restantes ?? 0})`);
    return partes.join(', ');
  }
  if (e.tipo === 'export') {
    const ok = (e.partes ?? []).filter((p) => p.ok).length;
    return `${ok} de ${(e.partes ?? []).length} parte${(e.partes ?? []).length === 1 ? '' : 's'}`;
  }
  const partes: string[] = [];
  if (e.pasadas) partes.push(`${e.pasadas} pasada${e.pasadas === 1 ? '' : 's'}`);
  if (e.errores) partes.push(`${e.errores} error${e.errores === 1 ? '' : 'es'}`);
  if (e.avisos) partes.push(`${e.avisos} aviso${e.avisos === 1 ? '' : 's'}`);
  return partes.join(', ');
}

const ORDEN_DE_NIVEL: Record<NivelHallazgo, number> = { error: 0, aviso: 1, info: 2, ok: 3 };

export const ICONO_DE_NIVEL: Record<NivelHallazgo, string> = { error: '●', aviso: '▲', info: 'ℹ', ok: '✓' };

/** Lo grave primero; dentro de cada nivel se conserva el orden del core. */
export function ordenarHallazgos(h: Hallazgo[]): Hallazgo[] {
  return h.map((x, i) => ({ x, i })).sort((a, b) => ORDEN_DE_NIVEL[a.x.nivel] - ORDEN_DE_NIVEL[b.x.nivel] || a.i - b.i).map((p) => p.x);
}

export function contarHallazgos(h: Hallazgo[]): Record<NivelHallazgo, number> {
  const n: Record<NivelHallazgo, number> = { error: 0, aviso: 0, info: 0, ok: 0 };
  for (const x of h) n[x.nivel] += 1;
  return n;
}
