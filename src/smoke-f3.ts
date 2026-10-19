// Smoke de aceptación de F3 (`LV_SMOKE=f3`). Corre sola, dentro de la app real, sobre una copia de `fixtures/errores` (un
// proyecto con problemas a propósito), y deja un JSON con el resultado: build que falla, problemas esperados, marcas en el
// gutter, F8 con un evento de teclado real, clic en el panel, filtros, y que las marcas siguen a las ediciones.
import { getBackend, type BuildEvent, type LaunchOptions } from './backend';
import { editarDoc, getDoc, textoDe } from './editor/docs';
import { lineasMarcadas } from './editor/problemas';
import { useApp } from './store/app';
import { dormir, esperarHasta } from './smoke-util';

const LIMITE_MS = 5 * 60 * 1000;

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

type Fin = Extract<BuildEvent, { type: 'finished' }>;

export async function correrSmokeF3(opts: LaunchOptions): Promise<void> {
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
  await backend.onBuildEvent((e) => eventos.push(e));
  const finales = () => eventos.filter((e): e is Fin => e.type === 'finished');
  const compilar = async (perfil: string): Promise<Fin> => {
    const n0 = finales().length;
    await store().compilar(perfil, { guardar: false });
    await esperarHasta(() => finales().length > n0, LIMITE_MS, `el build de ${perfil}`);
    const f = finales()[n0];
    // Los problemas llegan después del `finished`: se espera a que el store los tenga.
    await esperarHasta(() => store().build.status !== 'running' && store().build.errors === f.errors, 10_000, 'el conteo de problemas');
    await dormir(300);
    return f;
  };
  const f8 = (shift: boolean) => {
    const ev = new KeyboardEvent('keydown', { key: 'F8', shiftKey: shift, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    if (!ev.defaultPrevented) throw new Error('F8 no se frenó: WebView2 lo usaría para otra cosa');
  };
  const lineaDelCursor = (rel: string): number | null => {
    const e = getDoc(rel);
    return e ? e.state.doc.lineAt(e.state.selection.main.head).number : null;
  };
  const enLinea = (rel: string, n: number) => esperarHasta(() => store().activeRel === rel && lineaDelCursor(rel) === n, 10_000, `el cursor en ${rel}:${n}`);
  const marcas = (rel: string): number[] => {
    const e = getDoc(rel);
    return e ? lineasMarcadas(e.state) : [];
  };

  const trabajo = (async () => {
    await paso('proyecto abierto en modo manual', async () => {
      if (!store().project || store().rootFile !== 'main.tex') throw new Error(`proyecto/raíz inesperados: ${store().rootFile}`);
      await store().setAutoCompile('manual');
      // Este smoke prueba los problemas del build: el lint (F5) tiene el suyo y sumaría filas, marcas y saltos de F8.
      store().setFiltro({ lint: false });
    });

    await paso('el build falla y el conteo es el del log: 2 errores, 5 avisos, 1 caja mal llena', async () => {
      const f = await compilar('completo');
      if (f.ok) throw new Error('el build tenía que fallar');
      if (typeof f.errors !== 'number') throw new Error('el Finished no trae el conteo de problemas');
      const { errors, warnings, badboxes } = store().build;
      datos.conteo = { errors, warnings, badboxes };
      if (errors !== 2 || warnings !== 5 || badboxes !== 1) throw new Error(`conteo ${errors}/${warnings}/${badboxes}`);
      detalle(`${errors} errores, ${warnings} avisos, ${badboxes} caja mal llena`);
    });

    await paso('el panel de problemas se abre solo y lista los errores y avisos (las cajas, apagadas)', async () => {
      if (store().panelInferior !== 'problemas') throw new Error('el panel no se abrió');
      await esperarHasta(() => store().problems.length > 0, 10_000, 'la lista de problemas');
      if (store().problems.length !== 8) throw new Error(`${store().problems.length} problemas en total`);
      const filas = document.querySelectorAll('.problema:not(.lint)').length;
      if (filas !== 7) throw new Error(`${filas} filas visibles (se esperaban 7 sin contar el lint: 2 errores y 5 avisos)`);
      if (!document.querySelector('.problemas-resumen')?.textContent?.includes('2 errores')) throw new Error('falta el resumen en la barra superior');
      detalle(document.querySelector('.problemas-resumen')?.textContent ?? '');
    });

    await paso('un clic en un problema abre el archivo en su línea', async () => {
      const fila = [...document.querySelectorAll<HTMLElement>('.problema')].find((f) => f.textContent?.includes('Undefined control sequence'));
      if (!fila) throw new Error('no está la fila del error');
      fila.click();
      await enLinea('capitulo-roto.tex', 2);
    });

    await paso('el gutter marca las dos líneas con error', async () => {
      await esperarHasta(() => marcas('capitulo-roto.tex').length === 2, 5000, 'las marcas');
      const m = marcas('capitulo-roto.tex');
      if (m.join() !== '2,4') throw new Error(`marcas en ${m.join()}`);
      if (!document.querySelector('.cm-lv-problemas .lv-marca.error')) throw new Error('no hay marcador en el DOM');
      if (!document.querySelector('.lv-linea-error')) throw new Error('no hay línea subrayada en el DOM');
    });

    await paso('F8 avanza al siguiente problema y Mayús+F8 vuelve; da la vuelta al final', async () => {
      const n = store().problems.filter((p) => p.severity !== 'badbox' && p.file).length;
      // Desde el último visitado (el error de la línea 2) hasta el error de la línea 4 hay cuatro con ubicación en medio.
      store().setFiltro({}); // reinicia el recorrido
      f8(false);
      await esperarHasta(() => store().problemaIdx >= 0, 10_000, 'el primer F8');
      const primero = store().problemaIdx;
      f8(false);
      await esperarHasta(() => store().problemaIdx > primero, 10_000, 'el segundo F8');
      f8(true);
      await esperarHasta(() => store().problemaIdx === primero, 10_000, 'Mayús+F8');
      for (let i = 0; i < n; i++) {
        f8(false);
        await dormir(150);
      }
      if (store().problemaIdx !== primero) throw new Error(`no dio la vuelta: ${store().problemaIdx} contra ${primero}`);
      detalle(`${n} problemas con ubicación, recorrido completo y vuelta`);
    });

    await paso('el filtro de cajas mal llenas agrega la marca del overfull en su archivo', async () => {
      store().setFiltro({ badboxes: true });
      await store().abrirArchivo('capitulo-ok.tex');
      await esperarHasta(() => marcas('capitulo-ok.tex').length === 1, 5000, 'la marca del overfull');
      if (marcas('capitulo-ok.tex')[0] !== 2) throw new Error(`marca en ${marcas('capitulo-ok.tex')[0]}`);
      store().setFiltro({ badboxes: false });
      await esperarHasta(() => marcas('capitulo-ok.tex').length === 0, 5000, 'que se apague la marca');
    });

    await paso('las marcas siguen a las ediciones (una línea nueva arriba baja el marcador)', async () => {
      await store().abrirArchivo('main.tex');
      await esperarHasta(() => marcas('main.tex').length > 0, 5000, 'las marcas de main.tex');
      const antes = marcas('main.tex');
      editarDoc('main.tex', { from: 0, insert: '% una línea nueva\n' });
      await dormir(100);
      const despues = marcas('main.tex');
      if (despues.join() !== antes.map((l) => l + 1).join()) throw new Error(`antes ${antes.join()}, después ${despues.join()}`);
      detalle(`${antes.join(',')} pasó a ${despues.join(',')}`);
      // Se deshace para dejar el archivo como estaba.
      editarDoc('main.tex', { from: 0, to: '% una línea nueva\n'.length });
      if (getDoc('main.tex')!.state.doc.toString() !== textoDe('main.tex')) throw new Error('inconsistencia al deshacer');
    });

    await paso('arreglar el capítulo roto: los errores de LaTeX desaparecen y queda el de biber, que se abre en refs.bib', async () => {
      await store().abrirArchivo('capitulo-roto.tex');
      const t = textoDe('capitulo-roto.tex')!;
      const sin = t.replace('\\comandoquenoexiste{hola}', 'hola').replace(' } en esta línea', ' en esta línea');
      if (sin === t) throw new Error('no encontré qué arreglar');
      editarDoc('capitulo-roto.tex', { from: 0, to: t.length, insert: sin });
      await store().guardar('capitulo-roto.tex', { auto: false });
      const f = await compilar('completo');
      // Con los errores de LaTeX arreglados latexmk llega a biber, y el `refs.bib` roto del fixture es el error que queda.
      const errores = store().problems.filter((p) => p.severity === 'error');
      if (f.errors !== 1 || errores.length !== 1) throw new Error(`quedaron ${f.errors} errores: ${errores.map((p) => p.message).join(' | ')}`);
      const b = errores[0];
      if (b.kind !== 'biber' || b.file !== 'refs.bib' || b.line !== 10) throw new Error(`el error que queda no es el de biber en refs.bib:10: ${b.kind} ${b.file}:${b.line}`);
      if (marcas('capitulo-roto.tex').length !== 0) throw new Error('el gutter sigue marcando');
      detalle(`queda 1 error, el de biber (${b.file}:${b.line}); ${f.warnings} avisos`);
      // Y un clic en él abre el .bib en esa línea.
      const fila = [...document.querySelectorAll<HTMLElement>('.problema.error')].find((x) => x.textContent?.includes('syntax error'));
      if (!fila) throw new Error('no está la fila del error de biber');
      fila.click();
      await enLinea('refs.bib', 10);
    });

    await paso('un archivo que falta es un error con su archivo y su línea', async () => {
      await store().elegirRaiz('faltante.tex');
      const f = await compilar('completo');
      const p = store().problems.find((x) => x.kind === 'file-not-found');
      if (f.ok || !p) throw new Error('no apareció el error de archivo faltante');
      if (p.file !== 'faltante.tex' || p.line !== 5) throw new Error(`ubicación ${p.file}:${p.line}`);
      detalle(`${p.message} (${p.file}:${p.line})`);
    });
  })();

  const tope = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tope de tiempo')), LIMITE_MS * 2));
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
