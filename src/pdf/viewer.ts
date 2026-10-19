// Visor PDF sobre PDF.js. Portado del spike S3 (spikes/s3-pdfjs/src/main.ts).
//
// Lo que S3 midió y se respeta acá:
// - El visor viejo se desarma POR COMPLETO en cada recarga (señal de aborto, limpieza, canvas a 0x0, tarea de carga y
//   documento destruidos): con sólo `doc.destroy()` la memoria crecía ~33 MB por recarga y no se estabilizaba.
// - El contenedor tiene que ser `position: absolute` (o PDF.js falla) y es el elemento con scroll.
// - Los bytes llegan por un comando y PDF.js recibe una COPIA (`slice`): transfiere el buffer a su worker.
// El swap con dos visores superpuestos (sin parpadeo, S3) es de F2; en F1 la recarga puede parpadear.
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
  modo: 'ancho' | 'manual';
}

const ESCALA_MIN = 0.25;
const ESCALA_MAX = 5;

export class PdfViewerHost {
  private viewer: any = null;
  private doc: any = null;
  private task: any = null;
  private ac: AbortController | null = null;
  private modo: 'ancho' | 'manual' = 'ancho';
  private readonly oyentes = new Set<(e: PdfEstado) => void>();
  private readonly observador: ResizeObserver;
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  /** Las cargas se encolan: dos recargas seguidas no pueden pisarse a mitad de desarmar. */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly contenedor: HTMLDivElement,
    private readonly visorDiv: HTMLDivElement,
  ) {
    // En modo "ancho de página" el zoom sigue al tamaño del panel.
    this.observador = new ResizeObserver(() => {
      if (this.modo !== 'ancho' || !this.viewer) return;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => {
        if (this.viewer && this.modo === 'ancho') this.viewer.currentScaleValue = 'page-width';
      }, 120);
    });
    this.observador.observe(contenedor);
  }

  get tieneDocumento(): boolean {
    return this.doc !== null;
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

  cargar(bytes: Uint8Array): Promise<void> {
    const trabajo = this.cola.then(() => this.cargarAhora(bytes));
    this.cola = trabajo.catch(() => undefined);
    return trabajo;
  }

  private capturarPosicion(): Posicion | null {
    if (!this.viewer) return null;
    const pagina = this.viewer.currentPageNumber as number;
    const pv = this.viewer.getPageView(pagina - 1);
    if (!pv) return null;
    return { pagina, offset: this.contenedor.scrollTop - pv.div.offsetTop, escala: this.viewer.currentScale, modo: this.modo };
  }

  private async cargarAhora(bytes: Uint8Array): Promise<void> {
    const previa = this.capturarPosicion();
    await this.liberar();

    const ac = new AbortController();
    const bus = new EventBus();
    const link = new PDFLinkService({ eventBus: bus });
    // `abortSignal` está en el código de PDFViewer (lo usa para soltar el ResizeObserver y los listeners) pero no en sus
    // tipos de la 6.4.299: de ahí el `as any`. Es lo que estabiliza la memoria (S3).
    const viewer = new PDFViewer({
      container: this.contenedor,
      viewer: this.visorDiv,
      eventBus: bus,
      linkService: link,
      abortSignal: ac.signal,
    } as any);
    link.setViewer(viewer);

    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    const listo = new Promise<void>((r) => bus.on('pagesinit', () => r(), { once: true }));
    viewer.setDocument(doc);
    link.setDocument(doc);
    await listo;

    this.ac = ac;
    this.viewer = viewer;
    this.doc = doc;
    this.task = task;
    bus.on('pagechanging', () => this.emitir());
    bus.on('scalechanging', () => this.emitir());

    if (previa) {
      this.modo = previa.modo;
      if (previa.modo === 'manual') viewer.currentScale = previa.escala;
      else viewer.currentScaleValue = 'page-width';
      const pv = viewer.getPageView(Math.min(previa.pagina, viewer.pagesCount) - 1);
      if (pv) this.contenedor.scrollTop = pv.div.offsetTop + previa.offset;
    } else {
      this.modo = 'ancho';
      viewer.currentScaleValue = 'page-width';
    }
    this.emitir();
  }

  /** Desarma el visor actual del todo (ver el comentario de arriba: sin esto la memoria crece en cada recarga). */
  private async liberar(): Promise<void> {
    const { viewer, doc, task, ac } = this;
    this.viewer = this.doc = this.task = this.ac = null;
    if (!viewer && !doc && !task) return;
    ac?.abort();
    try {
      viewer?.cleanup?.();
    } catch {
      /* sin documento */
    }
    this.contenedor.querySelectorAll('canvas').forEach((c) => {
      c.width = 0;
      c.height = 0;
    });
    try {
      viewer?.setDocument(null);
    } catch {
      /* ya estaba vacío */
    }
    await task?.destroy?.();
    await doc?.destroy?.();
    this.visorDiv.replaceChildren();
  }

  async destruir(): Promise<void> {
    this.observador.disconnect();
    if (this.temporizador) clearTimeout(this.temporizador);
    await this.cola;
    await this.liberar();
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

  // --- para el smoke de aceptación -----------------------------------------------------------------------------------

  /** Las páginas que se ven están pintadas del todo (no placeholders ni a medio render). */
  paginasVisiblesListas(): boolean {
    const vistas = this.viewer?._getVisiblePages?.().views as { view: any }[] | undefined;
    return !!vistas && vistas.length > 0 && vistas.every((v) => v.view.renderingState === RenderingStates.FINISHED);
  }

  /** Primera página (1..N) cuyo texto contiene `texto`, o null. */
  async paginaConTexto(texto: string): Promise<number | null> {
    if (!this.doc) return null;
    for (let i = 1; i <= this.doc.numPages; i++) {
      const pagina = await this.doc.getPage(i);
      const contenido = await pagina.getTextContent();
      if (contenido.items.map((it: any) => it.str ?? '').join(' ').includes(texto)) return i;
    }
    return null;
  }
}

/** El visor que está en pantalla, para que el smoke pueda mirarlo sin pasar por React. */
export const pdfActual: { host: PdfViewerHost | null } = { host: null };
