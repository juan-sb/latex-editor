// Spike S3: recarga del PDF en PDF.js dentro de WebView2, sin parpadeo y conservando la posición.
//
// Corre sola al abrir y escribe todo en el archivo que dice S3_SALIDA. Compara dos técnicas con el libro rápido
// y con el completo:
//   A  `setDocument` sobre el mismo visor, restaurando página, zoom y desplazamiento.
//   B  dos visores superpuestos: el nuevo se arma y se pinta DETRÁS, y recién cuando sus páginas visibles
//      terminaron de pintarse pasa adelante y el viejo se destruye.
// Mide, por recarga: tiempo hasta que lo visible está pintado, cuadros en blanco (cuadros en los que el visor que
// se está mostrando tiene alguna página visible sin terminar de pintar), deriva de posición y memoria del árbol
// de procesos (WebView2 incluido).
import { invoke } from '@tauri-apps/api/core';
import * as pdfjsLib from 'pdfjs-dist';
import { EventBus, PDFLinkService, PDFViewer, RenderingStates } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type Visor = { cont: HTMLDivElement; viewer: any; bus: any; link: any; doc: any; task: any; ac: AbortController };
type Estado = { pagina: number; escala: number; offset: number };

const barra = document.getElementById('barra')!;
const decir = (t: string) => { barra.textContent = t; };
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ahora = () => performance.now();

async function leerBytes(path: string): Promise<Uint8Array> {
  const buf: ArrayBuffer = await invoke('read_pdf', { path });
  return new Uint8Array(buf);
}

function crearVisor(z: number): Visor {
  const cont = document.createElement('div');
  cont.className = 'cont';
  cont.style.zIndex = String(z);
  const v = document.createElement('div');
  v.className = 'pdfViewer';
  cont.appendChild(v);
  document.getElementById('app')!.appendChild(cont);
  const bus = new EventBus();
  const link = new PDFLinkService({ eventBus: bus });
  // abortSignal: PDFViewer suelta con ella su ResizeObserver, el vigilante de scroll y sus listeners. Sin ella
  // cada visor creado queda con todo eso vivo y reteniendo sus páginas (medido: +33 MB por recarga).
  const ac = new AbortController();
  const viewer = new PDFViewer({ container: cont, viewer: v, eventBus: bus, linkService: link, abortSignal: ac.signal });
  link.setViewer(viewer);
  return { cont, viewer, bus, link, doc: null, task: null, ac };
}

/** PDF.js transfiere el buffer al worker, así que se le pasa una copia: los bytes se reutilizan en cada recarga. */
async function abrir(vs: Visor, bytes: Uint8Array): Promise<void> {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const listo = new Promise<void>((r) => vs.bus.on('pagesinit', () => r(), { once: true }));
  vs.viewer.setDocument(doc);
  vs.link.setDocument(doc);
  await listo;
  vs.doc = doc;
  vs.task = task;
}

/** Desarma un visor entero: señal de aborto, limpieza de páginas, canvas a tamaño cero, tarea de carga y worker. */
async function destruir(vs: Visor): Promise<void> {
  vs.ac.abort();
  try { vs.viewer.cleanup?.(); } catch { /* sin documento */ }
  vs.cont.querySelectorAll('canvas').forEach((c) => { c.width = 0; c.height = 0; });
  try { vs.viewer.setDocument(null); } catch { /* ya estaba vacío */ }
  try { vs.link.setDocument(null); } catch { /* idem */ }
  await vs.task?.destroy?.();
  await vs.doc?.destroy?.();
  vs.cont.remove();
  vs.viewer = vs.doc = vs.task = vs.link = vs.bus = null as any;
}

const visibles = (vs: Visor) => (vs.viewer as any)._getVisiblePages().views as { view: any }[];
const visiblesListos = (vs: Visor) => {
  const v = visibles(vs);
  return v.length > 0 && v.every((x) => x.view.renderingState === RenderingStates.FINISHED);
};
async function esperarVisibles(vs: Visor, limiteMs = 60000): Promise<void> {
  const t0 = ahora();
  while (!visiblesListos(vs)) {
    if (ahora() - t0 > limiteMs) throw new Error('timeout esperando las páginas visibles');
    await frame();
  }
}

function estadoDe(vs: Visor): Estado {
  const pagina = vs.viewer.currentPageNumber as number;
  const pv = vs.viewer.getPageView(pagina - 1);
  return { pagina, escala: vs.viewer.currentScale as number, offset: vs.cont.scrollTop - pv.div.offsetTop };
}
function restaurar(vs: Visor, e: Estado): void {
  vs.viewer.currentScale = e.escala;
  const pv = vs.viewer.getPageView(e.pagina - 1);
  vs.cont.scrollTop = pv.div.offsetTop + e.offset;
}

/** Cuenta cuadros en los que `quien()` (el visor que se está mostrando en ese momento) tiene lo visible sin pintar. */
function contarBlancos(quien: () => Visor) {
  let activo = true;
  const r = { cuadros: 0, blancos: 0, maxRachaBlancos: 0 };
  let racha = 0;
  (async () => {
    while (activo) {
      await frame();
      r.cuadros++;
      if (!visiblesListos(quien())) { r.blancos++; racha++; r.maxRachaBlancos = Math.max(r.maxRachaBlancos, racha); } else racha = 0;
    }
  })();
  return { r, parar: () => { activo = false; } };
}

type Recarga = { tecnica: string; ms_hasta_visible: number; cuadros: number; cuadros_en_blanco: number; racha_max_blancos: number;
  deriva_pagina: number; deriva_px: number; mem_mb: number };

async function recargarA(vs: Visor, bytes: Uint8Array): Promise<Recarga> {
  const e = estadoDe(vs);
  const blancos = contarBlancos(() => vs);
  const t0 = ahora();
  const viejo = vs.doc, viejaTarea = vs.task;
  await abrir(vs, bytes);
  restaurar(vs, e);
  await esperarVisibles(vs);
  await frame();
  const ms = ahora() - t0;
  blancos.parar();
  await viejaTarea?.destroy?.();
  await viejo?.destroy?.();
  return cerrar('A', ms, blancos.r, e, vs);
}

async function recargarB(actual: Visor, bytes: Uint8Array): Promise<{ visor: Visor; rec: Recarga }> {
  const e = estadoDe(actual);
  let mostrado = actual;
  const blancos = contarBlancos(() => mostrado);
  const t0 = ahora();
  const nuevo = crearVisor(0); // detrás del actual, que sigue encima y a la vista
  await abrir(nuevo, bytes);
  restaurar(nuevo, e);
  await esperarVisibles(nuevo);
  // Recién ahora el nuevo pasa adelante.
  nuevo.cont.style.zIndex = '2';
  actual.cont.style.zIndex = '1';
  mostrado = nuevo;
  await frame();
  await frame();
  const ms = ahora() - t0;
  blancos.parar();
  await destruir(actual);
  return { visor: nuevo, rec: await cerrar('B', ms, blancos.r, e, nuevo) };
}

async function cerrar(tecnica: string, ms: number, b: { cuadros: number; blancos: number; maxRachaBlancos: number }, antes: Estado, vs: Visor): Promise<Recarga> {
  const despues = estadoDe(vs);
  return {
    tecnica,
    ms_hasta_visible: Math.round(ms),
    cuadros: b.cuadros,
    cuadros_en_blanco: b.blancos,
    racha_max_blancos: b.maxRachaBlancos,
    deriva_pagina: despues.pagina - antes.pagina,
    deriva_px: Math.round((despues.offset - antes.offset) * 10) / 10,
    mem_mb: Math.round((await invoke<number>('mem_mb')) * 10) / 10,
  };
}

async function visorInicial(bytes: Uint8Array, escala: number, paginaObjetivo: number): Promise<Visor> {
  const vs = crearVisor(1);
  await abrir(vs, bytes);
  vs.viewer.currentScale = escala;
  await frame();
  const n = vs.viewer.pagesCount as number;
  const pag = Math.min(paginaObjetivo, n);
  vs.cont.scrollTop = vs.viewer.getPageView(pag - 1).div.offsetTop + 120;
  await esperarVisibles(vs);
  return vs;
}

const resumen = (rs: Recarga[]) => {
  const ord = (k: keyof Recarga) => rs.map((r) => r[k] as number).sort((a, b) => a - b);
  const med = (k: keyof Recarga) => ord(k)[Math.floor(rs.length / 2)];
  const mx = (k: keyof Recarga) => ord(k)[rs.length - 1];
  return {
    n: rs.length,
    ms_mediana: med('ms_hasta_visible'), ms_max: mx('ms_hasta_visible'),
    cuadros_en_blanco_total: rs.reduce((s, r) => s + r.cuadros_en_blanco, 0), racha_max_blancos: mx('racha_max_blancos'),
    deriva_pagina_max: Math.max(...rs.map((r) => Math.abs(r.deriva_pagina))), deriva_px_max: Math.max(...rs.map((r) => Math.abs(r.deriva_px))),
    mem_mb_primera: rs[0].mem_mb, mem_mb_ultima: rs[rs.length - 1].mem_mb,
  };
};

async function medir(nombre: string, path: string, reps: number, salida: any, solo: string[] | null) {
  const bytes = await leerBytes(path);
  for (const tecnica of ['A', 'B']) {
    if (solo && !solo.includes(`${nombre}_${tecnica}`)) continue;
    decir(`S3: ${nombre}, técnica ${tecnica}…`);
    let vs = await visorInicial(bytes, 1.3, 60);
    const base = await invoke<number>('mem_mb');
    const recs: Recarga[] = [];
    for (let i = 0; i < reps; i++) {
      await dormir(400); // el usuario no recarga cuadro a cuadro
      if (tecnica === 'A') recs.push(await recargarA(vs, bytes));
      else { const r = await recargarB(vs, bytes); vs = r.visor; recs.push(r.rec); }
    }
    salida[`${nombre}_${tecnica}`] = { paginas: vs.viewer.pagesCount, mem_base_mb: Math.round(base), resumen: resumen(recs), recargas: recs };
    await destruir(vs);
    await dormir(500);
  }
}

async function main() {
  const salida: any = { webview: navigator.userAgent, pdfjs: pdfjsLib.version };
  const cfg = await invoke<any>('config');
  try {
    salida.mem_inicial_mb = Math.round(await invoke<number>('mem_mb'));
    const reps = Number(cfg.reps) || 10;
    const solo: string[] | null = cfg.solo ? String(cfg.solo).split(',') : null;
    await medir('rapido', cfg.pdfRapido, reps, salida, solo);
    await medir('completo', cfg.pdfCompleto, reps, salida, solo);
    if (solo) { salida.ok = true; throw new Error('__fin__'); } // corrida parcial: sin recompilar

    // Recompilar el rápido de verdad mientras el visor lo muestra: pdflatex tiene que poder escribir el PDF (el visor
    // sólo tiene los bytes en memoria) y la recarga B tiene que dejarlo al día.
    decir('S3: recompilando el rápido con el visor abierto…');
    let vs = await visorInicial(await leerBytes(cfg.pdfRapido), 1.3, 60);
    const sello0 = (await leerBytes(cfg.pdfRapido)).length;
    const [segundos, codigo] = await invoke<[number, number]>('compile_fast', { proyecto: cfg.proyecto, n: 1 });
    const nuevos = await leerBytes(cfg.pdfRapido);
    const r = await recargarB(vs, nuevos);
    vs = r.visor;
    salida.recompilar = { latexmk_s: Math.round(segundos * 10) / 10, codigo, bytes_antes: sello0, bytes_despues: nuevos.length, recarga: r.rec };
    await destruir(vs);
    salida.ok = true;
  } catch (e: any) {
    if (e?.message !== '__fin__') salida.error = String(e?.stack ?? e);
  }
  await invoke('write_result', { path: cfg.salida, json: JSON.stringify(salida, null, 2) });
  decir('S3: listo');
  await dormir(500);
  await invoke('salir');
}

window.addEventListener('DOMContentLoaded', () => { main(); });
