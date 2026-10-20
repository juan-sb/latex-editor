// Smoke de aceptación de F4 (`LV_SMOKE=f4`): SyncTeX sobre el libro, dentro de la app real. Es el criterio del plan:
//
//   en 50 párrafos largos al azar del libro, el forward cae en la palabra correcta en >= 90 %, el inverse deja el cursor a
//   <= 1 palabra en >= 90 %, y cada salto tarda <= 150 ms.
//
// Para cada párrafo se elige una palabra al azar (semilla fija), se hace el forward por el mismo camino que usa el usuario
// (`synctexForward` del core + `refinarForward`), se comprueba que el rectángulo resaltado contiene esa palabra en la capa
// de texto del PDF, se hace el inverse desde el centro de ese rectángulo y se comprueba que el cursor queda a una palabra o
// menos de la elegida. Además se mide que el resaltado coincide con las letras en pantalla (capa de texto de PDF.js) y que un
// doble clic de verdad en esa posición lleva a la misma palabra del fuente.
import { getBackend, type BuildEvent, type LaunchOptions, type SyncForward } from './backend';
import { getDoc, moverCursor } from './editor/docs';
import { pdfActual } from './pdf/viewer';
import { useApp } from './store/app';
import { refinarForward, refinarInverse } from './sync/saltos';
import { clave, palabrasDeLinea } from './sync/texto';
import { dormir, esperarHasta } from './smoke-util';

const LIMITE_MS = 20 * 60 * 1000;
const MUESTRAS = 50;

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

type Fin = Extract<BuildEvent, { type: 'finished' }>;

/** Un generador con semilla (mulberry32): el smoke elige lo mismo en cada corrida. */
function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentil = (v: number[], p: number): number => {
  const o = [...v].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor((o.length * p) / 100))] ?? 0;
};

export async function correrSmokeF4(opts: LaunchOptions): Promise<void> {
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

  interface Parrafo {
    rel: string;
    n: number;
    texto: string;
  }
  interface Medida {
    rel: string;
    n: number;
    palabra: string;
    fwdOk: boolean;
    fwdMs: number;
    invOk: boolean | null;
    invMs: number | null;
    nota?: string;
  }
  const medidas: Medida[] = [];


  /** Espera a que PDF.js haya dibujado la capa de texto de una página; si no llega, el error dice qué se ve. */
  const esperarCapaDeTexto = async (pagina: number, diag = ''): Promise<void> => {
    try {
      await esperarHasta(() => document.querySelectorAll(`.page[data-page-number="${pagina}"] .textLayer span`).length > 0, 10_000, 'la capa de texto');
    } catch (e) {
      const div = document.querySelector(`.page[data-page-number="${pagina}"]`);
      const cont = document.querySelector('.pdf-contenedor');
      const cc = cont as HTMLElement | null;
      const geo = `scrollHeight=${cc?.scrollHeight}, clientHeight=${cc?.clientHeight}, offsetTop=${(div as HTMLElement | null)?.offsetTop}, altoPagina=${(div as HTMLElement | null)?.offsetHeight}, contenedores=${document.querySelectorAll('.pdf-contenedor').length}`;
      throw new Error(`${e instanceof Error ? e.message : e} (${geo}; página ${pagina}: div=${!!div}, capas=${document.querySelectorAll('.textLayer').length}, páginas dibujadas=${document.querySelectorAll('.page').length}, scrollTop=${cont?.scrollTop}, rel=${store().activeRel}, etiqueta=${pdfActual.host?.etiqueta} contra ${store().pdfRel}#${store().pdfEpoch}; ${diag})`);
    }
  };

  const trabajo = (async () => {
    await paso('proyecto abierto; rápido compilado con SyncTeX', async () => {
      if (!store().project || store().project!.parts.length < 5) throw new Error('el proyecto del libro no tiene sus partes (¿latexviewer.json?)');
      await store().setAutoCompile('manual');
      await store().elegirPerfil('rapido');
      const n0 = finales().length;
      await store().compilar('rapido', { guardar: false });
      await esperarHasta(() => finales().length > n0, LIMITE_MS, 'el build del rápido');
      const f = finales()[n0];
      if (!f.ok) throw new Error(`el rápido salió mal (código ${f.code})`);
      await esperarHasta(() => pdfActual.host?.etiqueta === `${store().pdfRel}#${store().pdfEpoch}` && !!pdfActual.host?.paginasVisiblesListas(), 120_000, 'el PDF visible');
      datos.paginas = pdfActual.host!.paginas;
      detalle(`${(f.ms / 1000).toFixed(1)} s, ${datos.paginas} páginas`);
    });

    const parrafos: Parrafo[] = [];
    await paso(`elegir ${MUESTRAS} párrafos largos al azar de las partes (semilla fija)`, async () => {
      const rnd = azar(20261019);
      const candidatos: Parrafo[] = [];
      for (const parte of store().project!.parts) {
        if (!parte.file) continue;
        const r = await backend.readFile(parte.file);
        r.text.split('\n').forEach((texto, i) => {
          // Un párrafo largo de texto: una sola línea fuente, que empieza con una letra y no es un entorno ni un comando.
          if (texto.length >= 300 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(texto) && !/\\(begin|end|item|label)\b/.test(texto.slice(0, 40)) && palabrasDeLinea(texto).length >= 40) {
            candidatos.push({ rel: parte.file as string, n: i + 1, texto });
          }
        });
      }
      if (candidatos.length < MUESTRAS) throw new Error(`sólo hay ${candidatos.length} párrafos largos`);
      // Mezcla de Fisher-Yates con la semilla y se toman los primeros.
      for (let i = candidatos.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [candidatos[i], candidatos[j]] = [candidatos[j], candidatos[i]];
      }
      parrafos.push(...candidatos.slice(0, MUESTRAS));
      datos.candidatos = candidatos.length;
      detalle(`${candidatos.length} candidatos, ${new Set(parrafos.map((p) => p.rel)).size} partes distintas`);
    });

    await paso('forward e inverse sobre cada párrafo: palabra correcta y tiempo', async () => {
      const host = pdfActual.host!;
      const rnd = azar(7);
      for (const p of parrafos) {
        const palabras = palabrasDeLinea(p.texto);
        // Una palabra al azar de al menos 4 letras, lejos de los extremos del párrafo.
        const aptas = palabras.map((w, i) => (w.clave.length >= 4 && i >= 2 && i < palabras.length - 3 ? i : -1)).filter((i) => i >= 0);
        const idx = aptas[Math.floor(rnd() * aptas.length)];
        const w = palabras[idx];
        const m: Medida = { rel: p.rel, n: p.n, palabra: w.texto, fwdOk: false, fwdMs: 0, invOk: null, invMs: null };
        medidas.push(m);

        // --- forward ---
        const t0 = performance.now();
        const res: SyncForward | null = await backend.synctexForward(p.rel, p.n);
        if (!res) {
          m.nota = 'el core no dio cajas';
          continue;
        }
        const r = await refinarForward(host, res, p.texto, w.inicio + 1);
        m.fwdMs = performance.now() - t0;
        if (!r.palabra) {
          m.nota = 'cayó en las cajas de la línea (no encontró la palabra)';
          continue;
        }
        // La palabra resaltada es la que se buscaba: se mira qué dice la capa de texto en ese rectángulo.
        const enPagina = await host.palabrasDePagina(r.rects[0].page);
        const centro = (q: { x: number; y: number; w: number; h: number }) => ({ cx: q.x + q.w / 2, cy: q.y + q.h / 2 });
        const dentro = r.rects.map((q) => {
          const c = centro(q);
          return enPagina.find((x) => x.page === q.page && c.cx >= x.x && c.cx <= x.x + x.w && c.cy >= x.y && c.cy <= x.y + x.h);
        });
        const leida = dentro.map((x) => (x ? clave(x.texto) : '?')).join('');
        m.fwdOk = leida === w.clave;
        if (!m.fwdOk) m.nota = `esperaba «${w.clave}» y el resaltado dice «${leida}»`;

        // --- inverse: desde el centro del rectángulo que se resaltó ---
        const q = r.rects[0];
        const c = centro(q);
        const t1 = performance.now();
        const inv = await backend.synctexInverse(res.perfil, q.page, c.cx, c.cy);
        if (!inv || !inv.file) {
          m.invOk = false;
          m.nota = (m.nota ? `${m.nota}; ` : '') + 'el inverse no dio archivo';
          continue;
        }
        const doc = await backend.readFile(inv.file);
        const lineas = doc.text.split('\n');
        const ub = await refinarInverse(host, { page: q.page, x: c.cx, y: c.cy }, inv, { lineas: lineas.length, texto: (n) => lineas[n - 1] ?? '' });
        m.invMs = performance.now() - t1;
        const mismoLugar = inv.file === p.rel && ub.line === p.n && ub.indice !== undefined;
        m.invOk = mismoLugar && Math.abs((ub.indice as number) - idx) <= 1;
        if (!m.invOk) m.nota = (m.nota ? `${m.nota}; ` : '') + `inverse: ${inv.file}:${ub.line} palabra ${ub.indice} (esperaba ${p.rel}:${p.n} palabra ${idx})`;
      }
      const fwd = medidas.filter((m) => m.fwdOk).length;
      const inv = medidas.filter((m) => m.invOk).length;
      const tiempos = medidas.flatMap((m) => [m.fwdMs, m.invMs ?? 0]).filter((t) => t > 0);
      datos.forward = { ok: fwd, de: medidas.length };
      datos.inverse = { ok: inv, de: medidas.length };
      datos.tiempoMs = { mediana: Math.round(percentil(tiempos, 50)), p95: Math.round(percentil(tiempos, 95)), max: Math.round(Math.max(...tiempos)) };
      datos.fallas = medidas.filter((m) => !m.fwdOk || !m.invOk).slice(0, 12);
      detalle(`forward ${fwd}/${medidas.length}, inverse ${inv}/${medidas.length}; salto: mediana ${(datos.tiempoMs as { mediana: number }).mediana} ms, p95 ${(datos.tiempoMs as { p95: number }).p95} ms, máx ${(datos.tiempoMs as { max: number }).max} ms`);
      const piso = Math.ceil(medidas.length * 0.9);
      if (fwd < piso) throw new Error(`forward ${fwd}/${medidas.length} (piso ${piso}): ${JSON.stringify(datos.fallas).slice(0, 700)}`);
      if (inv < piso) throw new Error(`inverse ${inv}/${medidas.length} (piso ${piso}): ${JSON.stringify(datos.fallas).slice(0, 700)}`);
      if (percentil(tiempos, 95) > 150) throw new Error(`el p95 de un salto es ${Math.round(percentil(tiempos, 95))} ms (máximo 150)`);
    });

    await paso('el resaltado coincide con las letras en pantalla (capa de texto de PDF.js)', async () => {
      const host = pdfActual.host!;
      let ok = 0;
      let total = 0;
      const muestra = parrafos.slice(0, 10);
      for (const p of muestra) {
        await store().abrirArchivo(p.rel);
        const doc = getDoc(p.rel)!;
        const palabras = palabrasDeLinea(p.texto);
        const w = palabras[Math.floor(palabras.length / 2)];
        const lineaFuente = doc.state.doc.line(p.n);
        await dormir(60); // que la vista termine de cambiar a este archivo
        moverCursor(p.rel, lineaFuente.from + w.inicio + 1);
        total++;
        if (!(await store().irAlPdf())) continue;
        // El visor tiene que haber dibujado la capa de texto de la página para poder comparar.
        const res = await backend.synctexForward(p.rel, p.n);
        if (!res) continue;
        const r = await refinarForward(host, res, p.texto, w.inicio + 1);
        const pagina = r.rects[0].page;
        await esperarCapaDeTexto(pagina);
        await dormir(150);
        host.resaltar(pagina, r.rects, 4000);
        await dormir(50);
        const marca = document.querySelector('.lv-resaltado') as HTMLElement | null;
        if (!marca) continue;
        const mb = marca.getBoundingClientRect();
        const cx = mb.left + mb.width / 2;
        const cy = mb.top + mb.height / 2;
        const spans = [...document.querySelectorAll<HTMLElement>(`.page[data-page-number="${pagina}"] .textLayer span`)];
        const bajo = spans.find((s) => {
          const b = s.getBoundingClientRect();
          return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom && clave(s.textContent ?? '').includes(w.clave.slice(0, 4));
        });
        if (bajo) ok++;
        else {
          const cerca = spans.find((s) => clave(s.textContent ?? '').includes(w.clave));
          const b = cerca?.getBoundingClientRect();
          datos.alineacionFalla = { palabra: w.texto, resaltado: [Math.round(cx), Math.round(cy)], span: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null };
        }
      }
      datos.alineacion = { ok, de: total };
      detalle(`${ok}/${total} resaltados caen sobre el texto que se ve`);
      if (ok < Math.ceil(total * 0.9)) throw new Error(`alineación ${ok}/${total}: ${JSON.stringify(datos.alineacionFalla)}`);
    });

    await paso('seleccionar un tramo en el editor y saltar al PDF resalta el tramo entero (no una palabra suelta)', async () => {
      const host = pdfActual.host!;
      let ok = 0;
      let total = 0;
      let rectangulos = 0;
      for (const p of parrafos.slice(15, 25)) {
        await store().abrirArchivo(p.rel);
        const doc = getDoc(p.rel)!;
        const palabras = palabrasDeLinea(p.texto);
        // Un tramo de 8 palabras del medio del párrafo, seleccionado de derecha a izquierda (el cursor queda al principio): el caso que
        // fallaba era resaltar sólo la palabra donde quedó el cursor.
        const a = Math.floor(palabras.length / 2);
        const primera = palabras[a];
        const ultima = palabras[a + 7];
        const lineaFuente = doc.state.doc.line(p.n);
        await dormir(60);
        moverCursor(p.rel, lineaFuente.from + ultima.fin, lineaFuente.from + primera.inicio);
        total++;
        if (!(await store().irAlPdf())) continue;
        const res = await backend.synctexForward(p.rel, p.n);
        if (!res) continue;
        const pagina = (await refinarForward(host, res, p.texto, primera.inicio + 1)).rects[0].page;
        await esperarCapaDeTexto(pagina);
        await dormir(250);
        const marcas = [...document.querySelectorAll<HTMLElement>('.lv-resaltado')].map((m) => m.getBoundingClientRect());
        if (marcas.length === 0) continue;
        rectangulos += marcas.length;
        // Los `span` de la capa de texto son renglones enteros: «la palabra está bajo el resaltado» no distingue una palabra de ocho.
        // Se mide el ANCHO: lo resaltado tiene que ser lo que ocupan en el PDF las 8 palabras (según lo que mide un carácter en el
        // renglón donde está la primera), y el primer rectángulo tiene que estar en el renglón de la primera palabra.
        const spans = [...document.querySelectorAll<HTMLElement>(`.page[data-page-number="${pagina}"] .textLayer span`)];
        const spanDe = (m: DOMRect, k: string) =>
          spans.find((s) => {
            if (!clave(s.textContent ?? '').includes(k)) return false;
            const b = s.getBoundingClientRect();
            const cx = m.left + m.width / 2;
            const cy = m.top + m.height / 2;
            return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
          });
        const ordenadas = [...marcas].sort((x, y) => x.top - y.top || x.left - y.left);
        const enElRenglon = spanDe(ordenadas[0], primera.clave.length >= 4 ? primera.clave : clave(primera.texto + palabras[a + 1].texto));
        const caracteres = palabras.slice(a, a + 8).reduce((n, w) => n + w.texto.length, 0) + 7;
        const porCaracter = enElRenglon ? enElRenglon.getBoundingClientRect().width / Math.max(1, (enElRenglon.textContent ?? '').length) : 0;
        const esperado = caracteres * porCaracter;
        const ancho = marcas.reduce((n, m) => n + m.width, 0);
        if (enElRenglon && ancho >= esperado * 0.6 && ancho <= esperado * 1.5) ok++;
        else datos.tramoFalla = { primera: primera.texto, ultima: ultima.texto, marcas: marcas.length, ancho: Math.round(ancho), esperado: Math.round(esperado), enElRenglon: !!enElRenglon };
      }
      datos.tramo = { ok, de: total, rectangulos };
      detalle(`${ok}/${total} tramos con su primera y su última palabra bajo el resaltado (${rectangulos} rectángulos)`);
      if (ok < Math.ceil(total * 0.8)) throw new Error(`tramo ${ok}/${total}: ${JSON.stringify(datos.tramoFalla)}`);
    });

    await paso('un doble clic de verdad sobre el resaltado lleva a la misma palabra del fuente', async () => {
      const host = pdfActual.host!;
      let ok = 0;
      let total = 0;
      for (const p of parrafos.slice(10, 15)) {
        await store().abrirArchivo(p.rel);
        const doc = getDoc(p.rel)!;
        const palabras = palabrasDeLinea(p.texto);
        const w = palabras[Math.floor(palabras.length / 3)];
        const lineaFuente = doc.state.doc.line(p.n);
        await dormir(60); // que la vista termine de cambiar a este archivo
        moverCursor(p.rel, lineaFuente.from + w.inicio + 1);
        const res = await backend.synctexForward(p.rel, p.n);
        if (!res) continue;
        const r = await refinarForward(host, res, p.texto, w.inicio + 1);
        const pagina = r.rects[0].page;
        const salto = await store().irAlPdf();
        await esperarCapaDeTexto(pagina, `irAlPdf=${salto}, visible=${host.esVisible(pagina, r.rects[0])}, paginaActual=${host.estado().pagina}, rect=${JSON.stringify(r.rects[0])}`);
        host.resaltar(pagina, r.rects, 4000);
        await dormir(80);
        const marca = document.querySelector('.lv-resaltado') as HTMLElement | null;
        if (!marca) continue;
        const mb = marca.getBoundingClientRect();
        const blanco = document.elementFromPoint(mb.left + mb.width / 2, mb.top + mb.height / 2) ?? marca;
        total++;
        store().cerrarAviso();
        useApp.setState({ irA: null });
        blanco.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: mb.left + mb.width / 2, clientY: mb.top + mb.height / 2 }));
        await esperarHasta(() => store().irA !== null, 10_000, 'el salto al código');
        const ir = store().irA!;
        const lugar = ir.rel === p.rel && ir.line === p.n && ir.inicio !== undefined && ir.fin !== undefined;
        const palabraClic = lugar ? clave(p.texto.slice(ir.inicio, ir.fin)) : '';
        if (lugar && palabraClic === w.clave) ok++;
        else datos.dobleClicFalla = { esperaba: `${p.rel}:${p.n} «${w.clave}»`, obtuvo: `${ir.rel}:${ir.line} «${palabraClic}»` };
      }
      datos.dobleClic = { ok, de: total };
      detalle(`${ok}/${total} dobles clics llevaron a la palabra`);
      if (ok < Math.ceil(total * 0.8)) throw new Error(`doble clic ${ok}/${total}: ${JSON.stringify(datos.dobleClicFalla)}`);
    });
  })();

  const tope = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tope de tiempo')), LIMITE_MS + 60_000));
  try {
    await Promise.race([trabajo, tope]);
  } catch (e) {
    fallo = e instanceof Error ? e.message : String(e);
  }
  const resultado = { ok: fallo === null && pasos.every((x) => x.ok), fallo, pasos, ...datos };
  try {
    await backend.writeSmokeResult(JSON.stringify(resultado, null, 2));
    if (opts.smokePausaMs > 0) await dormir(opts.smokePausaMs);
  } finally {
    await backend.exitApp();
  }
}
