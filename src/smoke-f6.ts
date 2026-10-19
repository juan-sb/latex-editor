// Smoke de aceptación de F6 (`LV_SMOKE=f6`). Corre sola, dentro de la app real con TeX de verdad, sobre una copia de
// `fixtures/figuras-app` (modo `app`: la app inyecta la externalización de figuras) y deja un JSON con el resultado: el panel
// Figuras (Cocinar, progreso, por archivo), el disparo automático de la cocción antes de un build al cambiar el estilo, Limpiar
// con vista previa, una figura rota (error en el panel y en los problemas, sin imagen vieja) y Cancelar a mitad de una cocción.
import { getBackend, type BuildEvent, type LaunchOptions } from './backend';
import { editarDoc, textoDe } from './editor/docs';
import { dormir, esperarHasta } from './smoke-util';
import { useApp } from './store/app';

const LIMITE_MS = 4 * 60 * 1000;

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF6(opts: LaunchOptions): Promise<void> {
  const backend = getBackend();
  const store = () => useApp.getState();
  const pasos: Paso[] = [];
  const datos: Record<string, unknown> = { arranqueMs: Math.round(performance.now()) };
  let fallo: string | null = null;
  let nota: string | undefined;
  const detalle = (t: string) => {
    nota = t;
  };
  const paso = async <T>(nombre: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    nota = undefined;
    try {
      const r = await fn();
      pasos.push({ nombre, ok: true, ms: Date.now() - t0, detalle: nota });
      return r;
    } catch (e) {
      pasos.push({ nombre, ok: false, ms: Date.now() - t0, detalle: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  const eventos: BuildEvent[] = [];
  await backend.onBuildEvent((e) => {
    if (e.type !== 'log') eventos.push(e);
  });
  const secuencia = (desde = 0): string[] =>
    eventos
      .slice(desde)
      .map((e) => {
        if (e.type === 'bakelisting') return `listando(${e.fase})`;
        if (e.type === 'bakestarted') return `cocinar(${e.total})`;
        if (e.type === 'bakefinished') return `cocido(${e.ok ? 'ok' : e.cancelled ? 'cancelado' : 'falló'},${e.cooked})`;
        if (e.type === 'started') return `build(${e.perfil})`;
        if (e.type === 'finished') return `fin(${e.perfil},${e.ok ? 'ok' : 'falló'})`;
        return null;
      })
      .filter((x): x is string => x !== null);
  const ocioso = () => store().figProgreso === null && store().build.status !== 'running';
  const esperarOcioso = async (que: string) => {
    await dormir(400);
    await esperarHasta(ocioso, LIMITE_MS, que);
    await dormir(600); // los avisos y la recarga del estado llegan un instante después
  };
  const boton = (texto: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('.figuras button')].find((x) => x.textContent?.trim() === texto);
    if (!b) throw new Error(`no está el botón «${texto}» en el panel Figuras`);
    return b;
  };
  const archivoEnCache = async (): Promise<string[]> => (await backend.listDir('figuras-cache')).map((e) => e.name);
  const guardarCambio = async (rel: string, reemplazar: (t: string) => string) => {
    await store().abrirArchivo(rel);
    const t = textoDe(rel)!;
    const nuevo = reemplazar(t);
    if (nuevo === t) throw new Error(`el cambio no modificó ${rel}`);
    editarDoc(rel, { from: 0, to: t.length, insert: nuevo });
    await store().guardar(rel, { auto: false });
  };

  const trabajo = (async () => {
    await paso('proyecto abierto en modo `app`: el panel Figuras sabe que nada está listado todavía', async () => {
      if (!store().project || store().rootFile !== 'main.tex') throw new Error(`proyecto/raíz inesperados: ${store().rootFile}`);
      await store().setAutoCompile('manual');
      store().mostrarPanel('figuras');
      await esperarHasta(() => store().figuras !== null, 10_000, 'el estado de las figuras');
      const f = store().figuras!;
      if (f.modo !== 'app' || !f.sello || f.figlist !== null) throw new Error(`estado inesperado: ${JSON.stringify(f)}`);
      await esperarHasta(() => document.querySelector('.figuras-resumen')?.textContent?.includes('Todavía no se listaron') === true, 5000, 'el texto del panel');
      detalle(`sello ${f.sello}`);
    });

    await paso('Cocinar (clic real): lista, cocina las 4 figuras en paralelo y el panel las muestra por archivo', async () => {
      const desde = eventos.length;
      boton('Cocinar').click();
      await esperarHasta(() => secuencia(desde).some((e) => e.startsWith('cocido(')), LIMITE_MS, 'que termine la cocción');
      await esperarOcioso('el final de la cocción');
      const s = secuencia(desde);
      if (s.join() !== 'listando(todo),cocinar(4),cocido(ok,4)') throw new Error(`secuencia ${s.join()}`);
      const f = store().figuras!;
      if (f.actuales !== 4 || f.pendientes !== 0 || f.fallidas !== 0) throw new Error(`estado ${f.actuales}/${f.pendientes}/${f.fallidas}`);
      await esperarHasta(() => document.querySelectorAll('.figura.aldia').length === 4, 5000, 'las 4 figuras en el panel');
      const grupos = [...document.querySelectorAll('.figuras-grupo-cab .nombre')].map((x) => x.textContent);
      if (grupos.join('|') !== 'cap-a.tex|main.tex|Secciones/cap-b.tex') throw new Error(`grupos: ${grupos.join('|')}`);
      const archivos = await archivoEnCache();
      if (archivos.filter((n) => n.endsWith('.pdf')).length !== 4) throw new Error(`PDF en el cache: ${archivos.join(', ')}`);
      detalle(`${grupos.length} archivos con figuras`);
    });

    await paso('un build con el cache al día no cocina ni lista nada antes', async () => {
      const desde = eventos.length;
      await store().compilar('completo', { guardar: false });
      await esperarHasta(() => secuencia(desde).includes('fin(completo,ok)'), LIMITE_MS, 'el build');
      await esperarOcioso('el final del build');
      const s = secuencia(desde);
      if (s.join() !== 'build(completo),fin(completo,ok)') throw new Error(`secuencia ${s.join()}`);
    });

    await paso('cambiar el estilo y compilar: la cocción de las figuras del perfil va antes del build (y como es de todas las partes, no hay resto)', async () => {
      await guardarCambio('estilo.tex', (t) => `${t}% cambio\n`);
      await store().cargarFiguras();
      if (!store().figuras!.necesitaCocer) throw new Error('el panel no avisa que hay que cocinar antes de compilar');
      const desde = eventos.length;
      let vistoEnBarra = false;
      const observar = setInterval(() => {
        if (document.querySelector('.figuras-barra')) vistoEnBarra = true;
      }, 20);
      await store().compilar('completo', { guardar: false });
      await esperarHasta(() => secuencia(desde).includes('fin(completo,ok)'), LIMITE_MS, 'el build');
      await esperarOcioso('el final');
      clearInterval(observar);
      const s = secuencia(desde);
      // El perfil `completo` es de todas las partes: su listado ya fue el del documento entero y no hay un resto que cocinar después.
      const esperada = ['listando(perfil completo)', 'cocinar(4)', 'cocido(ok,4)', 'build(completo)', 'fin(completo,ok)'];
      if (s.join() !== esperada.join()) throw new Error(`secuencia ${s.join()}`);
      detalle(`barra de progreso vista: ${vistoEnBarra}`);
      datos.barraVista = vistoEnBarra;
      const f = store().figuras!;
      if (f.actuales !== 4 || f.viejas !== 4) throw new Error(`actuales ${f.actuales}, viejas ${f.viejas}`);
    });

    await paso('Limpiar muestra qué borra y cuántos MB, y sólo borra al confirmar', async () => {
      const antes = (await archivoEnCache()).length;
      boton('Limpiar').click();
      await esperarHasta(() => store().dialog !== null, 10_000, 'la confirmación');
      const msg = store().dialog!.mensaje;
      if (!/de 4 figuras que el proyecto ya no usa \(\d+\.\d MB\)/.test(msg)) throw new Error(`mensaje: ${msg}`);
      store().responderDialogo('cancelar');
      await dormir(300);
      if ((await archivoEnCache()).length !== antes) throw new Error('cancelar borró algo');
      boton('Limpiar').click();
      await esperarHasta(() => store().dialog !== null, 10_000, 'la segunda confirmación');
      store().responderDialogo('limpiar');
      await esperarHasta(() => store().figuras?.viejas === 0, 15_000, 'que el panel vea el cache limpio');
      const despues = (await archivoEnCache()).length;
      if (despues >= antes) throw new Error(`antes ${antes} archivos, después ${despues}`);
      detalle(msg);
    });

    await paso('una figura rota: el error está en el panel Figuras y en los problemas, no queda la imagen vieja, y arreglarla lo limpia', async () => {
      await guardarCambio('cap-a.tex', (t) => t.replace('\\begin{tikzpicture}\n', '\\begin{tikzpicture}\n    \\comandoQueNoExiste\n'));
      await store().compilar('completo', { guardar: false });
      await esperarHasta(() => eventos.some((e) => e.type === 'finished' && !e.cancelled && e.errors > 0), LIMITE_MS, 'el build con la figura rota');
      await esperarOcioso('el final');
      const f = store().figuras!;
      if (f.errores.length !== 1 || !f.errores[0].mensaje.includes('Undefined control sequence')) throw new Error(`errores: ${JSON.stringify(f.errores)}`);
      if (f.errores[0].file !== 'cap-a.tex') throw new Error(`archivo del error: ${f.errores[0].file}`);
      await esperarHasta(() => document.querySelectorAll('.figura-error').length === 1, 5000, 'el error en el panel');
      await esperarHasta(() => store().problems.some((p) => p.kind === 'figure'), 5000, 'el error en los problemas');
      if (!store().figuras!.figuras.some((x) => x.estado === 'fallo')) throw new Error('ninguna figura figura como fallida');
      const pdfs = (await archivoEnCache()).filter((n) => n.endsWith('.pdf'));
      if (pdfs.length !== 3) throw new Error(`quedó la imagen vieja de la rota: ${pdfs.length} PDF en el cache`);
      // Un clic en el error lleva a la línea del archivo.
      document.querySelector<HTMLElement>('.figura-error button')!.click();
      await esperarHasta(() => store().activeRel === 'cap-a.tex', 10_000, 'abrir cap-a.tex');
      // Arreglada la fuente, el build siguiente cocina la figura y el panel se limpia.
      await guardarCambio('cap-a.tex', (t) => t.replace('    \\comandoQueNoExiste\n', ''));
      await store().compilar('completo', { guardar: false });
      await esperarHasta(() => eventos.filter((e) => e.type === 'finished').length >= 4, LIMITE_MS, 'el build arreglado');
      await esperarOcioso('el final');
      if (store().figuras!.errores.length !== 0 || document.querySelectorAll('.figura-error').length !== 0) throw new Error('el error sigue en el panel');
      const pdfs2 = (await archivoEnCache()).filter((n) => n.endsWith('.pdf'));
      if (pdfs2.length !== 4) throw new Error(`${pdfs2.length} PDF después de arreglarla`);
    });

    await paso('Cancelar a mitad de una cocción: el panel vuelve a quieto y ningún .md5 da por buena una figura sin PDF', async () => {
      // Una figura lenta (60000 puntos) para que la cocción todavía esté corriendo cuando se cancela.
      await guardarCambio('cap-a.tex', (t) => t.replace('samples=30', 'samples=60000'));
      boton('Cocinar').click();
      await esperarHasta(() => store().figProgreso !== null && !store().figProgreso?.listando, LIMITE_MS, 'que empiece a cocinar');
      await esperarHasta(() => document.querySelector('.figuras-progreso') !== null && document.querySelector('.figuras-barra') !== null, 5000, 'la barra de progreso');
      const t0 = Date.now();
      boton('Cancelar').click();
      await esperarHasta(() => store().figProgreso === null, 30_000, 'que termine la cancelación');
      datos.cancelarMs = Date.now() - t0;
      await dormir(800);
      const archivos = await archivoEnCache();
      for (const n of archivos.filter((x) => x.endsWith('.md5'))) {
        const base = n.slice(0, -4);
        if (!archivos.includes(`${base}.pdf`)) throw new Error(`${n} sin PDF: da por buena una figura cancelada`);
      }
      const f = store().figuras;
      detalle(`cancelado en ${datos.cancelarMs} ms; ${f?.pendientes ?? '?'} pendiente(s)`);
    });
  })();

  const tope = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tope de tiempo')), LIMITE_MS * 3));
  try {
    await Promise.race([trabajo, tope]);
  } catch (e) {
    fallo = e instanceof Error ? e.message : String(e);
  }
  const resultado = { ok: fallo === null && pasos.every((p) => p.ok), fallo, pasos, ...datos };
  try {
    await backend.writeSmokeResult(JSON.stringify(resultado, null, 2));
    if (opts.smokePausaMs > 0) await dormir(opts.smokePausaMs);
  } finally {
    await backend.exitApp();
  }
}
