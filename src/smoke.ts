// Smoke de aceptación de F1 (`LV_SMOKE=1`). Corre sola, sobre la copia del libro, y deja un JSON con el resultado:
//
//   1. abre un capítulo y le inserta una palabra con un marcador en un párrafo,
//   2. guarda y compara los BYTES del disco con lo esperado (original + marcador, con el EOL y el BOM que tenía),
//   3. guarda de nuevo sin cambios y comprueba que el core no escribió y que el mtime no se movió,
//   4. compila el perfil completo,
//   5. espera el PDF visible y busca el marcador en su texto,
//   6. revierte el cambio, guarda y comprueba que los bytes vuelven a ser exactamente los originales.
//
// Sólo usa lo que usa la interfaz (el store y el backend) más los comandos `smoke_*` del core, que existen únicamente con
// `LV_SMOKE=1`. El marcador va dentro de `\mbox{}` para que TeX no lo parta con un guion al final de línea.
import { getBackend, type LaunchOptions } from './backend';
import { editarDoc, getDoc, textoDe } from './editor/docs';
import { pdfActual } from './pdf/viewer';
import { useApp } from './store/app';
import { bytesEsperados, dormir, esperarHasta, iguales, puntoDeInsercion } from './smoke-util';

const MARCADOR = 'LVSMOKEXQZ';
const INSERCION = `\\mbox{${MARCADOR}} `;
const LIMITE_TOTAL_MS = 15 * 60 * 1000;

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmoke(opts: LaunchOptions): Promise<void> {
  const backend = getBackend();
  const store = () => useApp.getState();
  const rel = opts.smokeFile ?? 'Secciones/Desnormalización.tex';
  const pasos: Paso[] = [];
  // Milisegundos desde que cargó la página hasta que el proyecto está abierto y el smoke arranca: es el arranque de la
  // interfaz más abrir la carpeta (la ventana ya existía).
  const datos: Record<string, unknown> = { archivo: rel, arranqueMs: Math.round(performance.now()) };
  let fallo: string | null = null;

  const paso = async <T>(nombre: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      pasos.push({ nombre, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      const detalle = e instanceof Error ? e.message : String(e);
      pasos.push({ nombre, ok: false, ms: Date.now() - t0, detalle });
      throw e;
    }
  };

  const trabajo = (async () => {
    // Con la auto-compilación de F2, Ctrl+S ya compila: este smoke compila cuando quiere, y el perfil que prueba es el completo.
    await store().setAutoCompile('manual');
    await paso('proyecto abierto y raíz elegida', async () => {
      if (!store().project) throw new Error('no hay proyecto abierto (¿LV_OPEN?)');
      if (!store().rootFile) throw new Error('no hay raíz elegida (¿LV_ROOT?)');
      datos.raiz = store().rootFile;
    });

    const original = await paso('leer los bytes originales', () => backend.smokeReadBytes(rel));
    await paso('abrir el archivo en una pestaña', async () => {
      await store().abrirArchivo(rel);
      const e = getDoc(rel);
      if (!e) throw new Error('no se abrió');
      if (e.readOnly) throw new Error('el archivo se abrió en sólo lectura (EOL mezclados)');
      datos.formato = { eol: e.eol, bom: e.bom };
    });

    const entry = getDoc(rel)!;
    const texto0 = textoDe(rel)!;
    const desde = puntoDeInsercion(texto0);
    const esperado = bytesEsperados(texto0.slice(0, desde) + INSERCION + texto0.slice(desde), entry.eol, entry.bom);
    // Antes de tocar nada, el formato que reconstruimos tiene que dar exactamente los bytes del original.
    await paso('el original se reconstruye byte a byte desde el texto normalizado', async () => {
      const r = iguales(bytesEsperados(texto0, entry.eol, entry.bom), original);
      if (r) throw new Error(r);
    });

    await paso('editar: marca de modificado', async () => {
      editarDoc(rel, { from: desde, insert: INSERCION });
      if (!store().tabs.find((t) => t.rel === rel)?.dirty) throw new Error('la pestaña no quedó modificada');
    });

    await paso('F5, Ctrl+R y Ctrl+P no llegan al navegador (se frenan en la ventana)', async () => {
      for (const init of [{ key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'p', ctrlKey: true }]) {
        const ev = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        document.body.dispatchEvent(ev);
        if (!ev.defaultPrevented) throw new Error(`${JSON.stringify(init)} no se frenó: recargaría la página y se perdería lo no guardado`);
      }
      // Desde F5 Ctrl+P abre el selector de archivos: se lo cierra para que el resto del smoke siga teclando.
      store().cerrarQuick();
    });

    await paso('Ctrl+S (evento de teclado real): guarda y bytes de disco = original + marcador, con el mismo EOL y BOM', async () => {
      const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      if (!ev.defaultPrevented) throw new Error('Ctrl+S no se frenó: WebView2 abriría "Guardar como"');
      await esperarHasta(() => !store().tabs.find((t) => t.rel === rel)?.dirty, 10_000, 'que Ctrl+S termine de guardar');
      const dif = iguales(await backend.smokeReadBytes(rel), esperado);
      if (dif) throw new Error(dif);
    });

    await paso('guardar sin cambios no escribe ni toca el mtime', async () => {
      const m1 = await backend.smokeMtime(rel);
      await dormir(50);
      const r = await store().guardar(rel, { forzar: true });
      if (r !== 'sin-cambios') throw new Error(`el core escribió (${r})`);
      const m2 = await backend.smokeMtime(rel);
      if (m1 !== m2) throw new Error(`el mtime cambió: ${m1} → ${m2}`);
    });

    await paso('compilar el completo', async () => {
      const t0 = Date.now();
      await store().compilar('completo');
      await esperarHasta(() => store().build.status !== 'idle' && store().build.status !== 'running', LIMITE_TOTAL_MS, 'el build');
      datos.buildMs = Date.now() - t0;
      datos.buildStatus = store().build.status;
      datos.buildCodigo = store().build.code;
      if (store().build.status !== 'ok') throw new Error(`el build terminó ${store().build.status} (código ${store().build.code})`);
    });

    await paso('el PDF se carga y sus páginas visibles quedan pintadas', async () => {
      await esperarHasta(() => !!pdfActual.host?.tieneDocumento, 120_000, 'que el visor cargue el PDF');
      await esperarHasta(() => !!pdfActual.host?.paginasVisiblesListas(), 120_000, 'las páginas visibles');
      datos.paginas = pdfActual.host!.paginas;
    });

    await paso('el marcador está en el texto del PDF', async () => {
      const pagina = await pdfActual.host!.paginaConTexto(MARCADOR);
      if (pagina === null) throw new Error('no apareció en ninguna página');
      datos.paginaDelMarcador = pagina;
    });

    await paso('zoom y navegación del visor', async () => {
      const h = pdfActual.host!;
      const e0 = h.estado();
      h.zoomMas();
      if (!(h.estado().escala > e0.escala) || h.estado().modo !== 'manual') throw new Error('zoomMas no cambió la escala');
      h.zoomMenos();
      h.zoomMenos();
      if (!(h.estado().escala < e0.escala)) throw new Error('zoomMenos no cambió la escala');
      h.ajustarAncho();
      if (h.estado().modo !== 'ancho') throw new Error('ajustarAncho no volvió al modo ancho');
      if (h.paginas >= 3) {
        h.irA(3);
        await esperarHasta(() => h.estado().pagina === 3, 10_000, 'ir a la página 3');
        h.siguiente();
        await esperarHasta(() => h.estado().pagina === 4 || h.paginas < 4, 10_000, 'página siguiente');
        h.anterior();
        await esperarHasta(() => h.estado().pagina === 3, 10_000, 'página anterior');
      }
      // Después de mover todo, las páginas que se ven tienen que terminar de pintarse.
      await esperarHasta(() => h.paginasVisiblesListas(), 60_000, 'las páginas visibles tras el zoom');
      datos.zoomFinal = Math.round(h.estado().escala * 100);
    });

    await paso('revertir: los bytes vuelven a ser los originales', async () => {
      editarDoc(rel, { from: desde, to: desde + INSERCION.length });
      if (textoDe(rel) !== texto0) throw new Error('el texto no volvió al original');
      const r = await store().guardar(rel);
      if (r !== 'guardado') throw new Error(`guardar devolvió ${r}`);
      const dif = iguales(await backend.smokeReadBytes(rel), original);
      if (dif) throw new Error(dif);
    });
  })();

  const tope = new Promise<never>((_, rechazar) =>
    setTimeout(() => rechazar(new Error(`tope de ${LIMITE_TOTAL_MS / 60000} minutos`)), LIMITE_TOTAL_MS + 60_000),
  );
  try {
    await Promise.race([trabajo, tope]);
  } catch (e) {
    fallo = e instanceof Error ? e.message : String(e);
  }

  const resultado = { ok: fallo === null && pasos.every((p) => p.ok), fallo, pasos, ...datos };
  try {
    await backend.writeSmokeResult(JSON.stringify(resultado, null, 2));
    // Pausa opcional (LV_SMOKE_PAUSA_MS): deja la interfaz a la vista para sacarle una captura antes de cerrar.
    if (opts.smokePausaMs > 0) await dormir(opts.smokePausaMs);
  } finally {
    await backend.exitApp();
  }
}
