// Lógica pura del panel Figuras: agrupar las figuras por archivo y los textos que se muestran. Sin React ni Tauri, para
// poder probarla.
import type { EstadoFiguras, FiguraInfo } from '../backend';

export interface GrupoDeFiguras {
  /** El archivo que declara el slug; `null` para las que no se pudieron atribuir. */
  archivo: string | null;
  figuras: FiguraInfo[];
  aldia: number;
  /** Pendientes o sin PDF. */
  pendientes: number;
  fallos: number;
}

/** Las figuras agrupadas por archivo, en orden alfabético; las sin archivo, al final. Dentro de cada grupo, en el orden de la lista. */
export function agruparFiguras(figuras: FiguraInfo[]): GrupoDeFiguras[] {
  const m = new Map<string | null, FiguraInfo[]>();
  for (const f of figuras) m.set(f.archivo, [...(m.get(f.archivo) ?? []), f]);
  return [...m.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'es')))
    .map(([archivo, fs]) => ({
      archivo,
      figuras: fs,
      aldia: fs.filter((f) => f.estado === 'aldia').length,
      pendientes: fs.filter((f) => f.estado === 'pendiente' || f.estado === 'falta').length,
      fallos: fs.filter((f) => f.estado === 'fallo').length,
    }));
}

export const megabytes = (bytes: number): string => (bytes / 1048576).toFixed(1);

/** "158 al día · 3 pendientes · 1 falló", sin lo que es cero. */
export function resumenDeFiguras(e: EstadoFiguras): string {
  const partes: string[] = [];
  const total = e.figlist?.total ?? 0;
  const aldia = e.figuras.filter((f) => f.estado === 'aldia').length;
  if (e.figlist) partes.push(`${aldia} de ${total} al día`);
  if (e.pendientes) partes.push(`${e.pendientes} pendiente${e.pendientes === 1 ? '' : 's'}`);
  if (e.fallidas) partes.push(`${e.fallidas} ${e.fallidas === 1 ? 'falló' : 'fallaron'}`);
  return partes.join(' · ');
}

/** El texto de la barra de progreso de una cocción en curso. */
export function textoDeProgreso(c: { fase: string; hechas: number; total: number; listando: boolean }): string {
  if (c.listando) return 'Listando las figuras…';
  return `Cocinando figuras ${c.hechas}/${c.total}`;
}
