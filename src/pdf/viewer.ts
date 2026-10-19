// Visor PDF sobre PDF.js. Portado del spike S3 (spikes/s3-pdfjs/src/main.ts), técnica B.
//
// Lo que S3 midió y se respeta acá:
// - **Dos visores superpuestos para recargar** (5.7 del plan): el nuevo se arma y se pinta DETRÁS del actual, recibe la
//   misma posición, y recién cuando sus páginas visibles terminaron de pintarse pasa adelante; entonces el viejo se
//   destruye. Medido con el libro (183 y 194 páginas): 0 cuadros en blanco y 0 de deriva en más de 130 recargas, ~220 a
//   230 ms hasta lo visible. `setDocument` sobre el mismo visor deja 4 a 9 cuadros en blanco por recarga y a veces
//   pierde la posición (un salto de 59 páginas).
// - El visor viejo se desarma POR COMPLETO (señal de aborto, limpieza, canvas a 0x0, tarea de carga y documento
//   destruidos): con sólo `doc.destroy()` la memoria crecía ~33 MB por recarga y no se estabilizaba.
// - Cada contenedor es `position: absolute` (o PDF.js falla) y es el elemento con scroll.
// - Los bytes llegan por un comando y PDF.js recibe una COPIA (`slice`): transfiere el buffer a su worker.
import * as pdfjsLib from 'pdfjs-dist';
import { EventBus, PDFLinkService, PDFViewer, RenderingStates } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfEstado {
  pagina: number;
  paginas: number;
  escala: number;
  modo: 'ancho' | 'manual';
}

interface Posicion {
  pagina: number;
  offset: number;
  escala: number;
}

/** Medición de una recarga (la misma que hizo S3): sirve para el smoke de aceptación. */
export interface MedicionRecarga {
  ms: number;
  cuadros: number;
  cuadrosEnBlanco: number;
  rachaMaxBlancos: number;
  derivaPagina: number;
  derivaPx: number;
}

interface Visor {
  cont: HTMLDivElement;
  viewer: any;
  bus: any;
  link: any;
  doc: any;
  task: any;
  ac: AbortController;
}

const ESCALA_MIN = 0.25;
const ESCALA_MAX = 5;
/** Si el visor nuevo no termina de pintar lo visible en este tiempo, se hace el cambio igual. */
const ESPERA_MAX_MS = 20_000;

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

const visiblesListos = (v: Visor): boolean => {
  const vistas = v.viewer?._getVisiblePages?.().views as { view: any }[] | undefined;
  return !!vistas && vistas.length > 0 && vistas.every((x) => x.view.renderingState === RenderingStates.FINISHED);
};

async function esperarVisibles(v: Visor, limiteMs: number): Promise<void> {
  const t0 = performance.now();
  while (!visiblesListos(v) && performance.now() - t0 < limiteMs) await frame();
}

export class PdfViewerHost {
  private actual: Visor | null = null;
  private modo: 'ancho' | 'manual' = 'ancho';
  private readonly oyentes = new Set<(e: PdfEstado) => void>();
  private readonly observador: ResizeObserver;
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  /** Las cargas se encolan: dos recargas seguidas no pueden pisarse a mitad de armar o de desarmar. */
  private cola: Promise<unknown> = Promise.resolve();

  /** `area` es el elemento (posicionado) donde se arman los contenedores de cada visor. */
  constructor(private readonly area: HTMLDivElement) {
    // En modo "ancho de página" el zoom sigue al tamaño del panel.
    this.observador = new ResizeObserver(() => {
      if (this.modo !== 'ancho' || !this.actual) return;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => {
        if (this.actual && this.modo === 'ancho') this.actual.viewer.currentScaleValue = 'page-width';
      }, 120);
    });
    this.observador.observe(area);
  }

  private get viewer(): any {
    return this.actual?.viewer ?? null;
  }

  get tieneDocumento(): boolean {
    return this.actual !== null;
  }

  get paginas(): number {
    return this.viewer?.pagesCount ?? 0;
  }

  estado(): PdfEstado {
    return {
      pagina: this.viewer?.currentPageNumber ?? 0,
      paginas: this.paginas,
      escala: this.viewer?.currentScale ?? 1,
      modo: this.modo,
    };
  }

  suscribir(cb: (e: PdfEstado) => void): () => void {
    this.oyentes.add(cb);
    return () => {
      this.oyentes.delete(cb);
    };
  }

  private emitir(): void {
    const e = this.estado();
    this.oyentes.forEach((cb) => cb(e));
  }

  // --- armar, mostrar y desarmar un visor -----------------------------------------------------------------------------

  private crear(z: number): Visor {
    const cont = document.createElement('div');
    cont.className = 'pdf-contenedor';
    cont.style.zIndex = String(z);
    const v = document.createElement('div');
    v.className = 'pdfViewer';
    cont.appendChild(v);
    this.area.appendChild(cont);
    const bus = new EventBus();
    const link = new PDFLinkService({ eventBus: bus });
    // `abortSignal` está en el código de PDFViewer (lo usa para soltar el ResizeObserver y los listeners) pero no en sus
    // tipos de la 6.4.299: de ahí el `as any`. Es lo que estabiliza la memoria (S3).
    const ac = new AbortController();
    const viewer = new PDFViewer({ container: cont, viewer: v, eventBus: bus, linkService: link, abortSignal: ac.signal } as any);
    link.setViewer(viewer);
    return { cont, viewer, bus, link, doc: null, task: null, ac };
  }

  private async abrir(v: Visor, bytes: Uint8Array): Promise<void> {
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    v.task = task;
    const doc = await task.promise;
    v.doc = doc;
    const listo = new Promise<void>((r) => v.bus.on('pagesinit', () => r(), { once: true }));
    v.viewer.setDocument(doc);
    v.link.setDocument(doc);
    await listo;
  }

  /** Desarma un visor entero: ver el comentario de arriba (sin esto la memoria crece en cada recarga). */
  private async liberar(v: Visor): Promise<void> {
    v.ac.abort();
    try {
      v.viewer.cleanup?.();
    } catch {
      /* sin documento */
    }
    v.cont.querySelectorAll('canvas').forEach((c) => {
      c.width = 0;
      c.height = 0;
    });
    try {
      v.viewer.setDocument(null);
    } catch {
      /* ya estaba vacío */
    }
    try {
      v.link.setDocument(null);
    } catch {
      /* idem */
    }
    await v.task?.destroy?.();
    await v.doc?.destroy?.();
    v.cont.remove();
  }

  private posicionDe(v: Visor): Posicion | null {
    const pagina = v.viewer.currentPageNumber as number;
    const pv = v.viewer.getPageView(pagina - 1);
    if (!pv) return null;
    return { pagina, offset: v.cont.scrollTop - pv.div.offsetTop, escala: v.viewer.currentScale };
  }

  private restaurar(v: Visor, previa: Posicion | null): void {
    if (!previa) {
      this.modo = 'ancho';
      v.viewer.currentScaleValue = 'page-width';
      return;
    }
    if (this.modo === 'manual') v.viewer.currentScale = previa.escala;
    else v.viewer.currentScaleValue = 'page-width';
    const pv = v.viewer.getPageView(Math.min(previa.pagina, v.viewer.pagesCount) - 1);
    if (pv) v.cont.scrollTop = pv.div.offsetTop + previa.offset;
  }

  /** `etiqueta` identifica qué PDF es (el store pasa `<ruta>#<época>`): queda en `etiqueta` al terminar la carga. */
  cargar(bytes: Uint8Array, etiqueta: string | null = null): Promise<void> {
    const trabajo = this.cola.then(() => this.cargarAhora(bytes, etiqueta));
    this.cola = trabajo.catch(() => undefined);
    return trabajo;
  }

  private async cargarAhora(bytes: Uint8Array, etiqueta: string | null): Promise<void> {
    const viejo = this.actual;
    const previa = viejo ? this.posicionDe(viejo) : null;
    // El primero va al frente; los siguientes se arman detrás del que se está mostrando.
    const nuevo = this.crear(viejo ? 1 : 2);
    try {
      await this.abrir(nuevo, bytes);
    } catch (e) {
      await this.liberar(nuevo);
      throw e;
    }
    this.restaurar(nuevo, previa);
    if (viejo) {
      await esperarVisibles(nuevo, ESPERA_MAX_MS);
      // Recién ahora el nuevo pasa adelante.
      nuevo.cont.style.zIndex = '2';
      viejo.cont.style.zIndex = '1';
      this.actual = nuevo;
      await frame();
      await frame();
      await this.liberar(viejo);
    } else {
      this.actual = nuevo;
    }
    nuevo.bus.on('pagechanging', () => this.emitir());
    nuevo.bus.on('scalechanging', () => this.emitir());
    this.etiqueta = etiqueta;
    this.emitir();
  }

  /** Recarga midiendo lo mismo que S3: tiempo hasta lo visible, cuadros en blanco del visor mostrado y deriva. */
  async cargarMedido(bytes: Uint8Array): Promise<MedicionRecarga> {
    const antes = this.actual ? this.posicionDe(this.actual) : null;
    const r = { cuadros: 0, blancos: 0, racha: 0, maxRacha: 0 };
    let activo = true;
    void (async () => {
      while (activo) {
        await frame();
        r.cuadros++;
        // El visor que se está mostrando: el actual hasta el cambio.
        if (this.actual && !visiblesListos(this.actual)) {
          r.blancos++;
          r.racha++;
          r.maxRacha = Math.max(r.maxRacha, r.racha);
        } else r.racha = 0;
      }
    })();
    const t0 = performance.now();
    await this.cargar(bytes);
    const ms = performance.now() - t0;
    activo = false;
    const despues = this.actual ? this.posicionDe(this.actual) : null;
    return {
      ms: Math.round(ms),
      cuadros: r.cuadros,
      cuadrosEnBlanco: r.blancos,
      rachaMaxBlancos: r.maxRacha,
      derivaPagina: despues && antes ? despues.pagina - antes.pagina : 0,
      derivaPx: despues && antes ? Math.round((despues.offset - antes.offset) * 10) / 10 : 0,
    };
  }

  async destruir(): Promise<void> {
    this.observador.disconnect();
    if (this.temporizador) clearTimeout(this.temporizador);
    await this.cola;
    const v = this.actual;
    this.actual = null;
    if (v) await this.liberar(v);
    this.oyentes.clear();
  }

  // --- zoom y navegación ------------------------------------------------------------------------------------------

  setEscala(escala: number): void {
    if (!this.viewer) return;
    this.modo = 'manual';
    this.viewer.currentScale = Math.min(ESCALA_MAX, Math.max(ESCALA_MIN, escala));
    this.emitir();
  }

  zoomMas(): void {
    if (this.viewer) this.setEscala(this.viewer.currentScale * 1.1);
  }

  zoomMenos(): void {
    if (this.viewer) this.setEscala(this.viewer.currentScale / 1.1);
  }

  ajustarAncho(): void {
    if (!this.viewer) return;
    this.modo = 'ancho';
    this.viewer.currentScaleValue = 'page-width';
    this.emitir();
  }

  irA(pagina: number): void {
    if (!this.viewer) return;
    this.viewer.currentPageNumber = Math.min(this.paginas, Math.max(1, Math.round(pagina)));
  }

  siguiente(): void {
    this.irA(this.estado().pagina + 1);
  }

  anterior(): void {
    this.irA(this.estado().pagina - 1);
  }

  // --- para los smokes de aceptación -----------------------------------------------------------------------------------

  /** Las páginas que se ven están pintadas del todo (no placeholders ni a medio render). */
  paginasVisiblesListas(): boolean {
    return !!this.actual && visiblesListos(this.actual);
  }

  /** La etiqueta del último PDF cargado del todo (con el swap hecho y el visor viejo ya desarmado). */
  etiqueta: string | null = null;

  /** Cuántos contenedores de visor hay armados ahora mismo: tiene que ser 1 fuera de una recarga. */
  get visoresArmados(): number {
    return this.area.querySelectorAll('.pdf-contenedor').length;
  }

  /** Primera página (1..N) cuyo texto contiene `texto`, o null. */
  async paginaConTexto(texto: string): Promise<number | null> {
    const visor = this.actual;
    const doc = visor?.doc;
    if (!doc) return null;
    const buscar = async (): Promise<number | null> => {
      for (let i = 1; i <= doc.numPages; i++) {
        // Si una recarga cambió de visor a mitad de la búsqueda, el documento viejo se destruye y `getPage` no vuelve.
        if (this.actual !== visor) return null;
        const pagina = await doc.getPage(i);
        const contenido = await pagina.getTextContent();
        if (contenido.items.map((it: any) => it.str ?? '').join(' ').includes(texto)) return i;
      }
      return null;
    };
    return Promise.race([buscar().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
  }
}

/** El visor que está en pantalla, para que el smoke pueda mirarlo sin pasar por React. */
export const pdfActual: { host: PdfViewerHost | null } = { host: null };
