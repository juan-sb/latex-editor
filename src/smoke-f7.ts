// Smoke de aceptación de F7 (`LV_SMOKE=f7`). Corre sola, dentro de la app real con TeX de verdad, sobre una copia tibia del libro
// (`scripts/aceptacion-f7.ps1` la arma, le pone la guardia a `\OpcionPie` y deja `export.dir` adentro de la copia) y deja un JSON:
//   - la variable `OpcionPie` llega al documento (el pie del parcial cambia con el menú),
//   - Ctrl+Alt+T abre el menú de compilación y Ctrl+\ alterna los tres layouts, con eventos de teclado reales,
//   - la vista previa de un fragmento (Ctrl+Alt+F): pestaña Fragmento, sin tocar el PDF del documento ni el cache de sus figuras,
//   - exportar dos partes con el número impreso (8 y 9), sin tocar la selección ni el PDF del parcial,
//   - archivos cambiados afuera: la app avisa que está lista (`.lv/f7-listo.txt`) y el script corre `gen_engranajes.py` con otro
//     parámetro; la app tiene que compilar UNA vez, recocinar sólo las figuras del anexo y no entrar en un bucle de builds.
import * as pdfjsLib from 'pdfjs-dist';
import { getBackend, PERFIL_EXPORT, PERFIL_FRAGMENTO, type BuildEvent, type LaunchOptions } from './backend';
import { moverCursor, textoDe } from './editor/docs';
import { dormir, esperarHasta } from './smoke-util';
import { useApp } from './store/app';

const LIMITE_MS = 6 * 60 * 1000;
const PARTE = 'Secciones/Desnormalización';
const DOS_PARTES = ['Secciones/Funciones de Aproximación', 'Secciones/Aproximación de Butterworth'];
const ARCHIVO_FRAGMENTO = 'Secciones/Aproximación de Butterworth.tex';

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF7(opts: LaunchOptions): Promise<void> {
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

  // Todos los eventos con su hora, y el log entero (para contar las subcompilaciones de figuras que lanzó pgf).
  const eventos: { e: BuildEvent; t: number }[] = [];
  let log = '';
  await backend.onBuildEvent((e) => {
    if (e.type === 'log') log += e.text;
    else eventos.push({ e, t: Date.now() });
  });
  const desde = () => eventos.length;
  const fin = (n: number, perfil: string) => eventos.slice(n).find((x) => x.e.type === 'finished' && x.e.perfil === perfil);
  const esperarFin = (n: number, perfil: string, que: string) => esperarHasta(() => fin(n, perfil) !== undefined, LIMITE_MS, que);
  const ocioso = () => store().build.status !== 'running' && store().exportando === null && store().figProgreso === null;
  const esperarOcioso = async (que: string) => {
    await dormir(500);
    await esperarHasta(ocioso, LIMITE_MS, que);
    await dormir(600);
  };
  const subcompilaciones = (desdeLog: number): string[] =>
    [...log.slice(desdeLog).matchAll(/-jobname "figuras-cache\/([^"]+)"/g)].map((m) => m[1]);
  const tecla = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  /** El texto de una página de un PDF del proyecto (por PDF.js, como lo ve el visor). */
  const textoDePdf = async (rel: string, pagina: number): Promise<{ texto: string; paginas: number }> => {
    const tarea = pdfjsLib.getDocument({ data: (await backend.readPdf(rel)).slice() });
    try {
      const doc = await tarea.promise;
      const p = await doc.getPage(Math.min(pagina, doc.numPages));
      const c = await p.getTextContent();
      return { texto: c.items.map((i) => ('str' in i ? i.str : '')).join(' '), paginas: doc.numPages };
    } finally {
      await tarea.destroy();
    }
  };

  const trabajo = (async () => {
    await paso('proyecto abierto: partes, variable OpcionPie, export.dir y el perfil de entrega', async () => {
      const p = store().project;
      if (!p?.config) throw new Error('no hay proyecto con configuración');
      if (p.parts.length !== 8) throw new Error(`se esperaban 8 partes y hay ${p.parts.length}`);
      if (p.config.variables.map((v) => v.name).join() !== 'OpcionPie') throw new Error(`variables: ${p.config.variables.map((v) => v.name).join()}`);
      if (p.config.exportDir !== 'export') throw new Error(`export.dir ${p.config.exportDir}`);
      if (!p.config.profiles.some((x) => x.id === 'entrega')) throw new Error('falta el perfil entrega');
      await store().setAutoCompile('manual');
      await store().soloParte(PARTE);
      await store().elegirPerfil('parcial');
    });

    await paso('la variable OpcionPie llega al documento: con «ninguno» el parcial no lleva el pie y con «completo» sí', async () => {
      const pie = async (valor: string): Promise<string> => {
        await store().setVariable('OpcionPie', valor);
        const n = desde();
        await store().compilar('parcial', { guardar: false });
        await esperarFin(n, 'parcial', `el parcial con OpcionPie=${valor}`);
        const f = fin(n, 'parcial')!.e;
        if (f.type !== 'finished' || !f.ok || !f.pdf) throw new Error(`el parcial con ${valor} no compiló`);
        // El pie está en las primeras páginas del capítulo (la primera es la portadilla, en estilo `plain`).
        let todo = '';
        for (const pagina of [1, 2, 3]) todo += ` ${(await textoDePdf(f.pdf, pagina)).texto}`;
        datos[`pie_${valor}_ms`] = f.ms;
        return todo;
      };
      const sin = await pie('ninguno');
      if (sin.includes('Extracto')) throw new Error('con OpcionPie=ninguno el pie sigue en el PDF');
      const con = await pie('completo');
      if (!con.includes('Extracto')) throw new Error('con OpcionPie=completo falta el pie');
      detalle(`parcial ${datos.pie_ninguno_ms} ms y ${datos.pie_completo_ms} ms`);
    });

    await paso('Ctrl+Alt+T (teclado real) abre el menú de compilación con perfiles, variables, exportar, cocinar y limpiar', async () => {
      tecla({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
      await esperarHasta(() => store().quick !== null, 3000, 'el menú');
      const q = store().quick!;
      const ids = q.items.map((i) => i.id);
      for (const id of ['compilar', 'perfil:parcial', 'perfil:rapido', 'perfil:entrega', 'variable:OpcionPie', 'exportar:todas', 'fragmento', 'cocinar', 'limpiar']) {
        if (!ids.includes(id)) throw new Error(`falta «${id}» en el menú: ${ids.join(', ')}`);
      }
      if (document.querySelector('.quick')?.getAttribute('aria-label') !== 'Compilación') throw new Error('el selector no se ve');
      store().cerrarQuick();
      detalle(`${ids.length} entradas`);
    });

    await paso('Ctrl+\\ (teclado real) recorre editor y PDF, sólo el editor, sólo el PDF y vuelve', async () => {
      const ancho = (sel: string) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().width ?? 0;
      await store().abrirArchivo(ARCHIVO_FRAGMENTO);
      await dormir(400);
      const vistos: string[] = [];
      const medir = () => `${store().layout}:${ancho('.editor-panel') > 40 ? 'E' : '-'}${ancho('.pdf-panel') > 40 ? 'P' : '-'}`;
      vistos.push(medir());
      for (let i = 0; i < 3; i++) {
        tecla({ key: '\\', code: 'Backslash', ctrlKey: true });
        await dormir(500);
        vistos.push(medir());
      }
      if (vistos.join() !== 'ambos:EP,editor:E-,pdf:-P,ambos:EP') throw new Error(`layouts: ${vistos.join(' ')}`);
      detalle(vistos.join(' '));
    });

    await paso('Ctrl+Alt+F: vista previa del fragmento en su pestaña, sin tocar el PDF del documento y con la figura en el cache', async () => {
      const pdfAntes = store().pdfRel;
      const epocaAntes = store().pdfEpoch;
      const buildAntes = store().build;
      await store().abrirArchivo(ARCHIVO_FRAGMENTO);
      const texto = textoDe(ARCHIVO_FRAGMENTO)!;
      const i = texto.indexOf('\\begin{tikzpicture}');
      if (i < 0) throw new Error('no encontré una figura en el capítulo');
      moverCursor(ARCHIVO_FRAGMENTO, texto.indexOf('\\draw', i));
      const n = desde();
      const l0 = log.length;
      const t0 = Date.now();
      tecla({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true });
      await esperarHasta(() => fin(n, PERFIL_FRAGMENTO) !== undefined, LIMITE_MS, 'el fragmento');
      const f = fin(n, PERFIL_FRAGMENTO)!.e;
      if (f.type !== 'finished' || !f.ok || !f.pdf) throw new Error('el fragmento no compiló');
      await esperarHasta(() => store().fragmento.estado === 'ok' && store().vistaPdf === 'fragmento', 5000, 'la pestaña Fragmento');
      await esperarHasta(() => document.querySelector('.pdf-pestana.activa')?.textContent?.startsWith('Fragmento') === true, 5000, 'la pestaña a la vista');
      datos.fragmentoFrioMs = Date.now() - t0;
      const t = await textoDePdf(f.pdf, 1);
      if (!t.texto.includes('Figura')) throw new Error(`el PDF del fragmento no tiene la figura: ${t.texto.slice(0, 200)}`);
      if (store().pdfRel !== pdfAntes || store().pdfEpoch !== epocaAntes) throw new Error('el PDF del documento cambió');
      if (store().build.status !== buildAntes.status || store().build.perfil !== buildAntes.perfil) throw new Error('el estado del build cambió');
      const figuras = subcompilaciones(l0);
      if (!figuras.every((x) => x.includes('-frag-'))) throw new Error(`el fragmento cocinó figuras que no son suyas: ${figuras.join(', ')}`);
      // Otra vez, igual: la figura ya está en el cache y no se recocina.
      const n2 = desde();
      const l1 = log.length;
      const t1 = Date.now();
      tecla({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true });
      await esperarHasta(() => fin(n2, PERFIL_FRAGMENTO) !== undefined, LIMITE_MS, 'el fragmento otra vez');
      datos.fragmentoTibioMs = Date.now() - t1;
      if (subcompilaciones(l1).length !== 0) throw new Error('la segunda vista previa recocinó la figura');
      store().mostrarVista('pdf');
      detalle(`${datos.fragmentoFrioMs} ms la primera (${figuras.length} figura cocinada), ${datos.fragmentoTibioMs} ms la segunda`);
    });

    await paso('exportar dos partes: números impresos 8 y 9, los PDF en export/, sin tocar la selección ni el PDF del parcial', async () => {
      const seleccion = store().project!.state.selection.join('|');
      const mtimeAntes = await backend.smokeMtime('.lv/build/parcial/lv-parcial.pdf');
      const n = desde();
      const t0 = Date.now();
      await store().exportarPartes(DOS_PARTES);
      await esperarHasta(() => eventos.slice(n).some((x) => x.e.type === 'exportfinished'), LIMITE_MS, 'la exportación');
      datos.exportarDosMs = Date.now() - t0;
      const f = eventos.slice(n).find((x) => x.e.type === 'exportfinished')!.e;
      if (f.type !== 'exportfinished' || !f.ok || f.exported !== 2) throw new Error(`exportación: ${JSON.stringify(f)}`);
      const progreso = eventos.slice(n).flatMap((x) => (x.e.type === 'exportprogress' ? [x.e] : []));
      const nums = progreso.map((p) => p.num).join(',');
      if (nums !== '8,9') throw new Error(`números impresos ${nums}`);
      for (const p of progreso) {
        const bytes = await backend.smokeReadBytes(p.file!);
        if (new TextDecoder().decode(bytes.slice(0, 4)) !== '%PDF') throw new Error(`${p.file} no es un PDF`);
      }
      datos.exportados = progreso.map((p) => p.file);
      if (store().project!.state.selection.join('|') !== seleccion) throw new Error('la exportación cambió la selección');
      if ((await backend.smokeMtime('.lv/build/parcial/lv-parcial.pdf')) !== mtimeAntes) throw new Error('la exportación tocó el PDF del parcial');
      // El log y los problemas del perfil `export` quedan disponibles, y el estado de la barra vuelve a quieto.
      await esperarOcioso('el final de la exportación');
      if (store().build.perfil === PERFIL_EXPORT) throw new Error('el estado del build quedó con el perfil export');
      detalle(`${datos.exportarDosMs} ms: ${progreso.map((p) => p.file).join(' y ')}`);
    });

    await paso('archivos cambiados afuera: la app queda lista, el script reescribe las figuras de los engranajes y compila una sola vez', async () => {
      await store().setAutoCompile('save');
      await store().elegirPerfil('rapido');
      // Un build de calentamiento deja el perfil al día: lo que sigue es sólo lo que pase por el observador.
      const n0 = desde();
      await store().compilar('rapido', { guardar: false });
      await esperarFin(n0, 'rapido', 'el rápido de calentamiento');
      await esperarOcioso('el calentamiento');
      const n = desde();
      const l0 = log.length;
      const epoca = store().pdfEpoch;
      await backend.writeFile('.lv/f7-listo.txt', `${Date.now()}\n`, null);
      // Acá el script de PowerShell corre `gen_engranajes.py` con otro parámetro y deja su hora en `.lv/f7-gen.txt`.
      await esperarHasta(() => fin(n, 'rapido') !== undefined, LIMITE_MS, 'el build que dispara el observador');
      const f = fin(n, 'rapido')!;
      if (f.e.type !== 'finished' || !f.e.ok) throw new Error('el build del observador falló');
      await esperarOcioso('el final del build');
      // Si el observador se viera a sí mismo (los auxiliares, el cache, `.lv/`), acá habría otro build. Se deja pasar un rato.
      await dormir(6000);
      const iniciados = eventos.slice(n).filter((x) => x.e.type === 'started' && x.e.perfil === 'rapido').length;
      if (iniciados !== 1) throw new Error(`se lanzaron ${iniciados} builds por el cambio`);
      if (!ocioso()) throw new Error('la app sigue trabajando después del build');
      const figuras = subcompilaciones(l0);
      if (figuras.length !== 2 || !figuras.every((x) => x.includes('-anexocauer-'))) throw new Error(`figuras cocinadas: ${figuras.join(', ') || 'ninguna'}`);
      if (store().pdfEpoch <= epoca) throw new Error('el visor no recargó el PDF');
      try {
        const gen = Number((await backend.readFile('.lv/f7-gen.txt')).text.trim());
        const iniciado = eventos.slice(n).find((x) => x.e.type === 'started' && x.e.perfil === 'rapido')!.t;
        datos.observadorHastaBuildMs = iniciado - gen;
        datos.observadorHastaPdfMs = f.t - gen;
      } catch {
        // sin la hora del script no hay latencia: el resto del criterio vale igual
      }
      datos.figurasRecocinadas = figuras;
      detalle(`1 build, figuras ${figuras.join(' y ')}; del script al build ${datos.observadorHastaBuildMs ?? '?'} ms y al PDF ${datos.observadorHastaPdfMs ?? '?'} ms`);
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
