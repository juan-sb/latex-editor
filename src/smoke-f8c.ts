// Smoke de aceptación de F8c (`LV_SMOKE=f8c`). Corre sola, dentro de la app real con TeX de verdad, sobre una copia de
// `fixtures/imagenes` con una imagen generada por el script (`scripts/aceptacion-f8c.ps1`):
//   - los botones de salto están sobre la barra entre el editor y el PDF (geometría medida en el DOM), y no en la barra del PDF,
//   - el interruptor de imágenes en borrador: el driver lleva graphicx y graphics, el PDF tiene las mismas páginas y pesa menos,
//   - un PDF en borrador no se publica; lo que se entrega (`entrega`, en `publish.names`) no va nunca en borrador,
//   - apagado, vuelve a las imágenes completas y se publica,
//   - los botones saltan de verdad (→ resalta en el PDF; ← va al texto elegido en el PDF) y apretarlos no arrastra la barra.
import { getBackend, type LaunchOptions } from './backend';
import { getDoc, moverCursor } from './editor/docs';
import { pdfApi } from './pdf/api';
import { dormir, esperarHasta } from './smoke-util';
import { useApp } from './store/app';

const LIMITE_MS = 5 * 60 * 1000;
const DRIVER_DRAFT = ['\\PassOptionsToPackage{draft}{graphicx}', '\\PassOptionsToPackage{draft}{graphics}'];

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF8c(opts: LaunchOptions): Promise<void> {
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

  /** Compila el perfil, espera a que termine y a que el visor muestre ese PDF; devuelve páginas y bytes. */
  const compilar = async (perfil: string): Promise<{ paginas: number; bytes: number; ms: number }> => {
    await store().compilar(perfil, { guardar: false });
    await esperarHasta(() => store().build.status !== 'running', LIMITE_MS, `el build de ${perfil}`);
    if (store().build.status !== 'ok') throw new Error(`el build de ${perfil} terminó ${store().build.status}`);
    await esperarHasta(() => pdfApi.host?.etiqueta === `${store().pdfRel}#${store().pdfEpoch}` && store().pdfEpoch > 0, 30_000, 'el visor con el PDF nuevo');
    const rel = store().pdfRel!;
    if (rel.split('/')[2] !== perfil) throw new Error(`el visor muestra ${rel}, no el de ${perfil}`);
    const bytes = (await backend.readPdf(rel)).length;
    const paginas = Number(/\/\s*(\d+)/.exec(document.querySelector('.pdf-barra .de')?.textContent ?? '')?.[1] ?? 0);
    return { paginas, bytes, ms: store().build.ms ?? 0 };
  };
  const driver = async (perfil: string) => (await backend.readFile(`.lv/drivers/lv-${perfil}.tex`)).text;
  const botonDraft = () => [...document.querySelectorAll<HTMLButtonElement>('.barra-superior button')].find((b) => (b.textContent ?? '').includes('🖼'))!;
  const salto = (cual: 'pdf' | 'codigo') => document.querySelector<HTMLButtonElement>(`.asa-medio .asa-salto[data-salto="${cual}"]`)!;
  const estadoBarra = () => document.querySelector('.estado-build')?.textContent ?? '';

  const trabajo = (async () => {
    await paso('los botones de salto cuelgan de la barra del medio, centrados, por encima de los paneles, y la barra del PDF ya no los tiene', async () => {
      await esperarHasta(() => store().project !== null && document.querySelector('.asa-medio .asa-salto') !== null, 30_000, 'los botones');
      if (store().layout !== 'ambos') throw new Error(`layout ${store().layout}`);
      const barra = document.querySelector<HTMLElement>('.asa-medio')!;
      const caja = barra.getBoundingClientRect();
      const botones = [...barra.querySelectorAll<HTMLButtonElement>('.asa-salto')];
      if (botones.length !== 2) throw new Error(`botones: ${botones.length}`);
      const rs = botones.map((b) => b.getBoundingClientRect());
      const cx = caja.left + caja.width / 2;
      const cy = caja.top + caja.height / 2;
      for (const r of rs) {
        if (Math.abs(r.left + r.width / 2 - cx) > 1.5) throw new Error(`un botón no está centrado sobre la barra: ${r.left + r.width / 2} contra ${cx}`);
        if (r.top < caja.top || r.bottom > caja.bottom) throw new Error('un botón se sale de la barra por arriba o por abajo');
        if (r.width < 16 || r.height < 16) throw new Error(`botón muy chico: ${r.width}x${r.height}`);
      }
      const medio = (rs[0].top + rs[1].bottom) / 2;
      if (Math.abs(medio - cy) > 2) throw new Error(`el par no está centrado en vertical: ${medio} contra ${cy}`);
      if (rs[1].top < rs[0].bottom) throw new Error('los botones se pisan');
      // Por encima de los paneles: lo que está en el centro de cada botón es el botón (no el editor ni el PDF).
      for (const [i, b] of botones.entries()) {
        const r = rs[i];
        const arriba = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (arriba !== b && !b.contains(arriba)) throw new Error(`encima del botón ${i} hay otra cosa: ${(arriba as HTMLElement | null)?.className}`);
      }
      const viejos = [...document.querySelectorAll('.pdf-barra .boton')].map((b) => b.textContent ?? '');
      if (viejos.some((t) => t.includes('→ PDF') || t.includes('← Código'))) throw new Error(`la barra del PDF todavía los tiene: ${viejos.join(' | ')}`);
      if (botones.some((b) => !b.disabled)) throw new Error('sin PDF los botones tenían que estar deshabilitados');
      datos.botones = { ancho: Math.round(rs[0].width), alto: Math.round(rs[0].height), barraAncho: Math.round(caja.width), desvioX: +(rs[0].left + rs[0].width / 2 - cx).toFixed(2), desvioY: +(medio - cy).toFixed(2) };
      detalle(`dos botones de ${Math.round(rs[0].width)}x${Math.round(rs[0].height)} px sobre una barra de ${Math.round(caja.width)} px, centrados (desvío ${datos.botones && (datos.botones as { desvioX: number }).desvioX} px en X)`);
    });

    await paso('sin el interruptor el driver no lleva draft y el PDF es el completo', async () => {
      if (store().project!.state.draftImages) throw new Error('el interruptor arrancó prendido');
      const r = await compilar('completo');
      const d = await driver('completo');
      if (DRIVER_DRAFT.some((l) => d.includes(l))) throw new Error(`el driver lleva draft sin el interruptor:\n${d}`);
      if (estadoBarra().includes('imágenes en borrador')) throw new Error('la barra dice borrador sin estarlo');
      if (r.paginas < 1) throw new Error(`páginas leídas de la barra: ${r.paginas}`);
      datos.completo = r;
      detalle(`${r.paginas} páginas, ${r.bytes} bytes, ${r.ms} ms`);
    });

    await paso('el interruptor de la barra: graphicx y graphics en el driver, mismas páginas, PDF más chico, y la barra lo dice', async () => {
      botonDraft().click();
      await esperarHasta(() => store().project!.state.draftImages, 10_000, 'el interruptor');
      if (!botonDraft().className.includes('activo')) throw new Error('el botón no se ve prendido');
      const r = await compilar('completo');
      const d = await driver('completo');
      for (const l of DRIVER_DRAFT) if (!d.includes(l)) throw new Error(`al driver le falta ${l}:\n${d}`);
      const antes = datos.completo as { paginas: number; bytes: number; ms: number };
      if (r.paginas !== antes.paginas) throw new Error(`cambió la paginación: ${antes.paginas} contra ${r.paginas} páginas`);
      if (r.bytes >= antes.bytes) throw new Error(`el PDF en borrador no pesa menos: ${r.bytes} contra ${antes.bytes}`);
      if (!estadoBarra().includes('imágenes en borrador')) throw new Error(`la barra no dice borrador: ${estadoBarra()}`);
      datos.borrador = r;
      detalle(`${r.paginas} páginas (igual), ${r.bytes} bytes contra ${antes.bytes} (${Math.round((1 - r.bytes / antes.bytes) * 100)} % menos), ${r.ms} ms contra ${antes.ms} ms`);
    });

    await paso('un PDF en borrador no se publica', async () => {
      let msg = '';
      try {
        await backend.publish('completo');
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      if (!msg.includes('borrador')) throw new Error(`publish de un PDF en borrador: «${msg}»`);
      detalle(msg);
    });

    await paso('lo que se entrega no va en borrador aunque el interruptor esté prendido, y se publica', async () => {
      const r = await compilar('entrega');
      const d = await driver('entrega');
      if (DRIVER_DRAFT.some((l) => d.includes(l))) throw new Error(`el driver de la entrega lleva draft:\n${d}`);
      if (estadoBarra().includes('imágenes en borrador')) throw new Error('la barra dice borrador para la entrega');
      const completo = datos.completo as { bytes: number };
      if (r.bytes < completo.bytes * 0.9) throw new Error(`la entrega pesa ${r.bytes} y el completo ${completo.bytes}: parece en borrador`);
      const p = await backend.publish('entrega');
      if (!p.pdf.includes('Imagenes.pdf')) throw new Error(`publicó ${p.pdf}`);
      detalle(`entrega ${r.bytes} bytes publicada en ${p.pdf}`);
    });

    await paso('apagado el interruptor, el perfil vuelve a las imágenes completas y se publica', async () => {
      botonDraft().click();
      await esperarHasta(() => !store().project!.state.draftImages, 10_000, 'apagar el interruptor');
      const r = await compilar('completo');
      const d = await driver('completo');
      if (DRIVER_DRAFT.some((l) => d.includes(l))) throw new Error(`el driver sigue con draft:\n${d}`);
      const antes = datos.completo as { paginas: number };
      if (r.paginas !== antes.paginas) throw new Error(`páginas: ${r.paginas}`);
      const p = await backend.publish('completo');
      detalle(`publicado ${p.pdf}`);
    });

    const LINEA = 'Un párrafo entre las dos imágenes';
    const rastro = (m: string) => `${m} [rel=${store().activeRel}, pdf=${store().pdfRel}, aviso=${store().notice?.texto ?? ''}]`;

    await paso('→ con el cursor en una línea resalta el lugar en el PDF', async () => {
      await store().abrirArchivo('main.tex');
      const doc = getDoc('main.tex')!;
      const texto = doc.state.doc.toString();
      const donde = texto.indexOf('primera imagen');
      if (donde < 0) throw new Error('el fixture no tiene el texto esperado');
      await dormir(100);
      moverCursor('main.tex', donde + 3);
      await esperarHasta(() => !salto('pdf').disabled, 10_000, 'el botón → habilitado');
      store().cerrarAviso();
      salto('pdf').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      salto('pdf').click();
      try {
        await esperarHasta(() => document.querySelector('.lv-resaltado') !== null, 15_000, 'el resaltado en el PDF');
      } catch (e) {
        throw new Error(rastro(e instanceof Error ? e.message : String(e)));
      }
      const marca = document.querySelector<HTMLElement>('.lv-resaltado')!.getBoundingClientRect();
      const area = document.querySelector<HTMLElement>('.pdf-area')!.getBoundingClientRect();
      if (marca.bottom < area.top || marca.top > area.bottom) throw new Error('el resaltado no está a la vista en el PDF');
      detalle('el resaltado aparece dentro del visor');
    });

    await paso('← con texto elegido en el PDF va a ese texto en el código y lo selecciona', async () => {
      await esperarHasta(() => document.querySelectorAll('.page .textLayer span').length > 0, 15_000, 'la capa de texto');
      const spans = [...document.querySelectorAll<HTMLElement>('.page .textLayer span')];
      const span = spans.find((s) => (s.textContent ?? '').includes('entre las dos'));
      if (!span || !span.firstChild) throw new Error(`no encontré en el PDF la línea del segundo párrafo (spans: ${spans.length})`);
      span.scrollIntoView({ block: 'center' });
      await dormir(150);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const nodo = span.firstChild;
      sel.setBaseAndExtent(nodo, 0, nodo, (nodo.textContent ?? '').length);
      const elegido = sel.toString();
      if (elegido.length < 10) throw new Error(`la selección quedó en «${elegido}»`);
      // Apretar el botón con un mousedown de verdad no puede deshacer la selección: el botón lo frena.
      const mouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      salto('codigo').dispatchEvent(mouse);
      if (!mouse.defaultPrevented) throw new Error('el mousedown del botón no se frenó: le robaría el foco y la selección al PDF');
      if (sel.isCollapsed) throw new Error('el mousedown deshizo la selección');
      const host = pdfApi.host!;
      const punta = host.puntoDeSeleccion?.();
      if (!punta) throw new Error('puntoDeSeleccion no devolvió nada con texto elegido');
      useApp.setState({ irA: null });
      store().cerrarAviso();
      salto('codigo').click();
      try {
        await esperarHasta(() => store().irA !== null, 15_000, 'el salto al código');
      } catch (e) {
        throw new Error(rastro(e instanceof Error ? e.message : String(e)));
      }
      const ir = store().irA!;
      const doc = getDoc('main.tex')!;
      const l = doc.state.doc.line(ir.line).text;
      if (ir.rel !== 'main.tex' || !l.includes(LINEA)) throw new Error(`fue a ${ir.rel}:${ir.line} «${l.slice(0, 60)}»; elegí «${elegido.slice(0, 40)}»`);
      if (ir.inicio === undefined || ir.fin === undefined || ir.fin <= ir.inicio) throw new Error(`sin tramo: ${ir.inicio}-${ir.fin}`);
      const tramo = l.slice(ir.inicio, ir.fin);
      datos.tramoCodigo = tramo;
      detalle(`fue a main.tex:${ir.line} y seleccionó «${tramo}» (en el PDF elegí «${elegido.slice(0, 40)}…»)`);
    });

    await paso('apretar un botón no arrastra la barra; apretar la barra misma sí (control)', async () => {
      const barra = document.querySelector<HTMLElement>('.asa-medio')!;
      const antes = barra.getBoundingClientRect().left;
      const b = salto('pdf').getBoundingClientRect();
      const ev = (tipo: string, x: number, y: number) =>
        new PointerEvent(tipo, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: tipo === 'pointerup' || tipo === 'pointerover' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
      // El puntero llega al botón (React arma pointerenter/leave con pointerover/pointerout) y recién ahí aprieta.
      const centroX = b.left + b.width / 2;
      const centroY = b.top + b.height / 2;
      salto('pdf').dispatchEvent(ev('pointerover', centroX, centroY));
      await dormir(150);
      const habilitadaSobreBoton = barra.getAttribute('data-panel-resize-handle-enabled');
      salto('pdf').dispatchEvent(ev('pointerdown', centroX, centroY));
      await dormir(100);
      const activoConBoton = barra.hasAttribute('data-resize-handle-active');
      datos.arrastreDetalle = { habilitadaSobreBoton, activa: barra.getAttribute('data-resize-handle-active'), estado: barra.getAttribute('data-resize-handle-state') };
      document.dispatchEvent(ev('pointermove', b.left + 120, b.top));
      await dormir(100);
      document.dispatchEvent(ev('pointerup', b.left + 120, b.top));
      await dormir(100);
      const despues = barra.getBoundingClientRect().left;
      // El puntero sale de los botones: la barra vuelve a andar.
      salto('pdf').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerId: 1, pointerType: 'mouse' }));
      await dormir(150);
      // Control: el mismo gesto sobre la barra, fuera de los botones, la activa (si no, la prueba de arriba no probaría nada).
      const c = barra.getBoundingClientRect();
      barra.dispatchEvent(ev('pointerdown', c.left + c.width / 2, c.top + 8));
      await dormir(100);
      const activoSolo = barra.hasAttribute('data-resize-handle-active');
      document.dispatchEvent(ev('pointerup', c.left + c.width / 2, c.top + 8));
      await dormir(100);
      datos.arrastre = { activoConBoton, activoSolo, mueveElBoton: Math.abs(despues - antes) };
      if (activoConBoton) throw new Error('apretar un botón activó el arrastre de la barra');
      if (Math.abs(despues - antes) > 0.5) throw new Error(`la barra se movió ${despues - antes} px`);
      if (!activoSolo) throw new Error('el control no activó la barra: la prueba no vale (¿otro tipo de evento?)');
      detalle(`botón: arrastre ${activoConBoton ? 'sí' : 'no'}, barra sola: ${activoSolo ? 'sí' : 'no'}`);
    });

    await paso('con un solo panel a la vista los botones no están', async () => {
      store().alternarLayout();
      await dormir(300);
      if (store().layout !== 'editor') throw new Error(`layout ${store().layout}`);
      if (document.querySelector('.asa-sync')) throw new Error('los botones siguen con un solo panel');
      store().alternarLayout();
      store().alternarLayout();
      await esperarHasta(() => store().layout === 'ambos' && document.querySelector('.asa-medio .asa-salto') !== null, 5000, 'los botones al volver');
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
