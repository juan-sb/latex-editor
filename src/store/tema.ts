// Tema de la interfaz: sistema, claro u oscuro. La elección vive en `preferencias.json` de la config del usuario (como el
// `keybindings.json`) y se resuelve acá a `data-theme="light"|"dark"` en <html>; el CSS sólo mira ese atributo.
import { create } from 'zustand';
import { getBackend } from '../backend';

export type Tema = 'sistema' | 'claro' | 'oscuro';

const ARCHIVO = 'preferencias.json';
const ORDEN: Tema[] = ['sistema', 'claro', 'oscuro'];

export const temaEfectivo = (tema: Tema, sistemaOscuro: boolean): 'light' | 'dark' =>
  tema === 'oscuro' || (tema === 'sistema' && sistemaOscuro) ? 'dark' : 'light';

export const siguienteTema = (tema: Tema): Tema => ORDEN[(ORDEN.indexOf(tema) + 1) % ORDEN.length];

/** Lo que dice `preferencias.json`; cualquier cosa rara (archivo ausente, JSON roto, valor desconocido) es `sistema`. */
export function temaDeTexto(texto: string | null): Tema {
  if (!texto) return 'sistema';
  try {
    const t = (JSON.parse(texto) as { tema?: unknown } | null)?.tema;
    return t === 'claro' || t === 'oscuro' ? t : 'sistema';
  } catch {
    return 'sistema';
  }
}

export const textoDelTema = (t: Tema): string =>
  t === 'sistema' ? 'según el sistema' : t === 'claro' ? 'claro' : 'oscuro';

const consulta = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

let escucha: (() => void) | null = null;

/** Pone `data-theme` en <html>. En modo `sistema` sigue los cambios del sistema operativo mientras no se elija otro. */
export function aplicarTema(tema: Tema): void {
  const mq = consulta();
  const poner = () => {
    document.documentElement.dataset.theme = temaEfectivo(tema, mq?.matches ?? false);
  };
  if (escucha && mq) mq.removeEventListener('change', escucha);
  escucha = null;
  poner();
  if (tema === 'sistema' && mq) {
    escucha = poner;
    mq.addEventListener('change', escucha);
  }
}

interface TemaState {
  tema: Tema;
  /** Cambia el tema, lo aplica y lo guarda. */
  setTema: (t: Tema) => Promise<void>;
  alternar: () => Promise<void>;
}

export const useTema = create<TemaState>()((set, get) => ({
  tema: 'sistema',
  setTema: async (t) => {
    set({ tema: t });
    aplicarTema(t);
    try {
      await getBackend().writeUserConfig(ARCHIVO, JSON.stringify({ tema: t }, null, 2) + '\n');
    } catch {
      // Sin disco el tema igual rige en esta sesión.
    }
  },
  alternar: () => get().setTema(siguienteTema(get().tema)),
}));

/** Al arrancar: lee la preferencia y la aplica antes de pintar la app (así no hay un destello con el tema equivocado). */
export async function cargarTema(): Promise<void> {
  let texto: string | null = null;
  try {
    texto = await getBackend().readUserConfig(ARCHIVO);
  } catch {
    texto = null;
  }
  const tema = temaDeTexto(texto);
  useTema.setState({ tema });
  aplicarTema(tema);
}
