// Smoke de aceptación de F5 (`LV_SMOKE=f5`). Corre sola, dentro de la app real, sobre una copia de `fixtures/editor` (un
// proyecto chico con lint a propósito) y deja un JSON con el resultado. No compila nada: prueba el editor y la navegación con
// eventos de teclado reales (formato, autocompletado con el menú de CodeMirror, F12 y Alt+←, Ctrl+P, paleta, esquema),
// la búsqueda y el reemplazo contra el core y contra los bytes de disco, el lint en el gutter y el `keybindings.json`.
import { getBackend, type LaunchOptions } from './backend';
import { aplicarKeybindings, cargarKeybindings, COMANDOS } from './comandos/comandos';
import { contenidoDeVista, editarDoc, escribirComoTecleado, getDoc, moverCursor, textoDe } from './editor/docs';
import { lineasMarcadas } from './editor/problemas';
import { dormir, esperarHasta, iguales } from './smoke-util';
import { useApp } from './store/app';

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF5(opts: LaunchOptions): Promise<void> {
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

  /** Un `keydown` real: lo recibe el editor (si lo hay) y sube hasta el despachador de la ventana. */
  const tecla = (init: KeyboardEventInit & { key: string }, destino?: EventTarget): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    (destino ?? contenidoDeVista() ?? document.body).dispatchEvent(ev);
    return ev;
  };
  const ctrl = (letra: string, extra: KeyboardEventInit = {}, destino?: EventTarget) =>
    tecla({ key: letra, code: `Key${letra.toUpperCase()}`, ctrlKey: true, ...extra }, destino);
  const lineaDelCursor = (rel: string): number | null => {
    const e = getDoc(rel);
    return e ? e.state.doc.lineAt(e.state.selection.main.head).number : null;
  };
  const enLinea = (rel: string, n: number) => esperarHasta(() => store().activeRel === rel && lineaDelCursor(rel) === n, 10_000, `el cursor en ${rel}:${n}`);
  const posDe = (rel: string, aguja: string, desplazamiento = 0): number => {
    const i = textoDe(rel)!.indexOf(aguja);
    if (i < 0) throw new Error(`no encontré «${aguja}» en ${rel}`);
    return i + desplazamiento;
  };
  /** Restaura un documento al texto que tenía (sin guardarlo). */
  const restaurar = (rel: string, texto: string) => {
    const actual = textoDe(rel)!;
    if (actual !== texto) editarDoc(rel, { from: 0, to: actual.length, insert: texto });
  };
  const hayQuick = () => document.querySelector('.quick') !== null;
  const items = () => [...document.querySelectorAll<HTMLElement>('.quick-item .titulo')].map((x) => x.textContent ?? '');
  const escribirEnQuick = (texto: string) => {
    const input = document.querySelector<HTMLInputElement>('.quick-entrada');
    if (!input) throw new Error('no hay selector abierto');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, texto);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const enQuick = (init: KeyboardEventInit & { key: string }) => tecla(init, document.querySelector('.quick-entrada') ?? document.body);

  const trabajo = (async () => {
    await paso('proyecto abierto y el índice de símbolos listo (5 etiquetas, 3 secciones, 2 entradas de .bib, 4 de lint)', async () => {
      if (!store().project || store().rootFile !== 'main.tex') throw new Error(`proyecto/raíz inesperados: ${store().rootFile}`);
      await store().setAutoCompile('manual');
      await esperarHasta(() => store().simbolos !== null, 10_000, 'el índice de símbolos');
      const s = store().simbolos!;
      const c = `${s.labels.length} etiquetas, ${s.sections.length} secciones, ${s.bib.length} del .bib, ${s.lint.length} de lint, ${s.scan_ms} ms`;
      datos.simbolos = { labels: s.labels.length, sections: s.sections.length, bib: s.bib.length, lint: s.lint.length, scan_ms: s.scan_ms };
      if (s.labels.length !== 5 || s.sections.length !== 3 || s.bib.length !== 2 || s.lint.length !== 4) throw new Error(c);
      detalle(c);
    });

    await paso('el lint marca el gutter de cap-dos.tex (líneas 2, 3 y 4) y aparece en el panel de problemas', async () => {
      await store().abrirArchivo('cap-dos.tex');
      await esperarHasta(() => lineasMarcadas(getDoc('cap-dos.tex')!.state).length === 3, 5000, 'las marcas de lint');
      const m = lineasMarcadas(getDoc('cap-dos.tex')!.state);
      if (m.join() !== '2,3,4') throw new Error(`marcas en ${m.join()}`);
      store().mostrarPanelInferior('problemas');
      await esperarHasta(() => document.querySelectorAll('.problema.lint').length === 4, 5000, 'las filas de lint');
      if (!document.querySelector('.lv-marca.lint')) throw new Error('el marcador de lint no está en el DOM');
      // Con la casilla de lint apagada desaparecen del panel y del gutter.
      store().setFiltro({ lint: false });
      await esperarHasta(() => lineasMarcadas(getDoc('cap-dos.tex')!.state).length === 0, 5000, 'que se apaguen las marcas');
      store().setFiltro({ lint: true });
      await esperarHasta(() => lineasMarcadas(getDoc('cap-dos.tex')!.state).length === 3, 5000, 'que vuelvan las marcas');
    });

    await paso('Ctrl+B: envuelve la selección en \\textbf{…} y vuelve a sacarlo; Ctrl+I sin selección deja el cursor adentro', async () => {
      await store().abrirArchivo('cap-uno.tex');
      const original = textoDe('cap-uno.tex')!;
      const a = posDe('cap-uno.tex', 'repetida');
      moverCursor('cap-uno.tex', a, a + 'repetida'.length);
      const ev = ctrl('b');
      if (!ev.defaultPrevented) throw new Error('Ctrl+B no se frenó');
      if (!textoDe('cap-uno.tex')!.includes('\\textbf{repetida} repetida')) throw new Error(`no envolvió: ${textoDe('cap-uno.tex')!.split('\n')[1]}`);
      ctrl('b');
      if (textoDe('cap-uno.tex') !== original) throw new Error('el segundo Ctrl+B no lo sacó');
      moverCursor('cap-uno.tex', a);
      ctrl('i');
      const t = textoDe('cap-uno.tex')!;
      if (t.slice(a, a + 8) !== '\\textit{') throw new Error('Ctrl+I no insertó \\textit{}');
      if (getDoc('cap-uno.tex')!.state.selection.main.head !== a + 8) throw new Error('el cursor no quedó adentro');
      restaurar('cap-uno.tex', original);
    });

    await paso('en modo matemático Ctrl+B pone \\mathbf; Ctrl+/ comenta y descomenta la línea; Ctrl+M y Ctrl+E', async () => {
      const original = textoDe('cap-uno.tex')!;
      const a = posDe('cap-uno.tex', 'mc^2');
      moverCursor('cap-uno.tex', a, a + 4);
      ctrl('b');
      if (!textoDe('cap-uno.tex')!.includes('E = \\mathbf{mc^2}')) throw new Error(`no cambió a \\mathbf: ${textoDe('cap-uno.tex')!.split('\n')[3]}`);
      restaurar('cap-uno.tex', original);
      moverCursor('cap-uno.tex', posDe('cap-uno.tex', 'Un párrafo', 3));
      tecla({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true });
      if (!textoDe('cap-uno.tex')!.startsWith('\\section{Primer capítulo}\\label{sec:uno}\n% Un párrafo')) throw new Error('no comentó');
      tecla({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true });
      if (textoDe('cap-uno.tex') !== original) throw new Error('no descomentó');
      const b = posDe('cap-uno.tex', 'palabra');
      moverCursor('cap-uno.tex', b, b + 'palabra'.length);
      ctrl('e');
      if (!textoDe('cap-uno.tex')!.includes('\\emph{palabra}')) throw new Error('Ctrl+E no envolvió en \\emph');
      restaurar('cap-uno.tex', original);
      moverCursor('cap-uno.tex', b, b + 'palabra'.length);
      ctrl('m');
      if (!textoDe('cap-uno.tex')!.includes('$palabra$')) throw new Error('Ctrl+M no puso $…$');
      restaurar('cap-uno.tex', original);
      if (store().tabs.find((t) => t.rel === 'cap-uno.tex')?.dirty) throw new Error('la pestaña quedó modificada');
    });

    await paso('autocompletar: \\ref{sec:u abre el menú real con la etiqueta y Enter la acepta; lo mismo con \\cite{kn', async () => {
      await store().abrirArchivo('main.tex');
      const original = textoDe('main.tex')!;
      const fin = original.length;
      moverCursor('main.tex', fin);
      escribirComoTecleado('\\ref{sec:u');
      await esperarHasta(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((x) => x.textContent?.includes('sec:uno')), 5000, 'el menú con sec:uno');
      tecla({ key: 'Enter', code: 'Enter', keyCode: 13 });
      await esperarHasta(() => textoDe('main.tex')!.includes('\\ref{sec:uno'), 5000, 'que Enter acepte la etiqueta');
      restaurar('main.tex', original);
      moverCursor('main.tex', original.length);
      escribirComoTecleado('\\cite{kn');
      await esperarHasta(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((x) => x.textContent?.includes('knuth84')), 5000, 'el menú con knuth84');
      const opcion = [...document.querySelectorAll('.cm-tooltip-autocomplete li')].find((x) => x.textContent?.includes('knuth84'))!;
      detalle(opcion.textContent ?? '');
      tecla({ key: 'Enter', code: 'Enter', keyCode: 13 });
      await esperarHasta(() => textoDe('main.tex')!.includes('\\cite{knuth84'), 5000, 'que Enter acepte la clave');
      restaurar('main.tex', original);
      if (store().tabs.find((t) => t.rel === 'main.tex')?.dirty) throw new Error('la pestaña quedó modificada');
    });

    await paso('F12 salta de \\ref a su \\label, de \\cite al .bib y de \\input al archivo; Alt+← y Alt+→ recorren el historial', async () => {
      await store().abrirArchivo('main.tex');
      moverCursor('main.tex', posDe('main.tex', '\\ref{sec:uno}', 8));
      const origen = lineaDelCursor('main.tex')!;
      const ev = tecla({ key: 'F12', code: 'F12' });
      if (!ev.defaultPrevented) throw new Error('F12 no se frenó');
      await enLinea('cap-uno.tex', 1);
      tecla({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
      await enLinea('main.tex', origen);
      tecla({ key: 'ArrowRight', code: 'ArrowRight', altKey: true });
      await enLinea('cap-uno.tex', 1);
      await store().abrirArchivo('main.tex');
      moverCursor('main.tex', posDe('main.tex', '\\cite{knuth84}', 9));
      tecla({ key: 'F12', code: 'F12' });
      await enLinea('refs.bib', 1);
      await store().abrirArchivo('main.tex');
      moverCursor('main.tex', posDe('main.tex', '\\input{cap-dos}', 9));
      tecla({ key: 'F12', code: 'F12' });
      await enLinea('cap-dos.tex', 1);
      detalle(`historial de ${store().historial.length} lugares`);
    });

    await paso('Shift+F12 lista dónde se usa una etiqueta y un clic en la lista salta ahí', async () => {
      await store().abrirArchivo('main.tex');
      moverCursor('main.tex', posDe('main.tex', '\\ref{sec:uno}', 8));
      tecla({ key: 'F12', code: 'F12', shiftKey: true });
      await esperarHasta(hayQuick, 5000, 'la lista de usos');
      const filas = items();
      if (filas.length !== 1 || !filas[0].startsWith('main.tex:8')) throw new Error(`usos: ${filas.join(' | ')}`);
      document.querySelector<HTMLElement>('.quick-item')!.click();
      await enLinea('main.tex', 8);
      if (hayQuick()) throw new Error('el selector no se cerró');
    });

    await paso('Ctrl+P abre el selector de archivos, filtra "capdos" y Enter abre cap-dos.tex', async () => {
      const ev = ctrl('p');
      if (!ev.defaultPrevented) throw new Error('Ctrl+P no se frenó: WebView2 imprimiría');
      await esperarHasta(hayQuick, 5000, 'el selector');
      const todos = items();
      if (todos.length !== 4) throw new Error(`${todos.length} archivos: ${todos.join(', ')}`);
      escribirEnQuick('capdos');
      await esperarHasta(() => items()[0] === 'cap-dos.tex', 5000, 'el filtro');
      enQuick({ key: 'Enter', code: 'Enter' });
      await esperarHasta(() => store().activeRel === 'cap-dos.tex' && !hayQuick(), 5000, 'que abra cap-dos.tex');
    });

    await paso('Ctrl+Shift+P: la paleta lista todos los comandos y filtra; Escape la cierra', async () => {
      ctrl('p', { shiftKey: true });
      await esperarHasta(hayQuick, 5000, 'la paleta');
      if (items().length !== COMANDOS.length - 1) throw new Error(`${items().length} comandos contra ${COMANDOS.length - 1}`);
      escribirEnQuick('definicion');
      await esperarHasta(() => items()[0]?.includes('Ir a la definición') === true, 5000, 'el filtro de la paleta');
      enQuick({ key: 'Escape', code: 'Escape' });
      await esperarHasta(() => !hayQuick(), 5000, 'que Escape cierre');
    });

    await paso('Ctrl+Shift+O (este archivo) y Ctrl+T (proyecto) listan secciones y etiquetas', async () => {
      await store().abrirArchivo('cap-uno.tex');
      ctrl('o', { shiftKey: true });
      await esperarHasta(hayQuick, 5000, 'ir a sección del archivo');
      if (items().length !== 3) throw new Error(`en el archivo: ${items().join(' | ')}`);
      enQuick({ key: 'Escape' });
      await esperarHasta(() => !hayQuick(), 5000, 'cerrar');
      ctrl('t');
      await esperarHasta(hayQuick, 5000, 'ir a sección del proyecto');
      if (items().length !== 8) throw new Error(`en el proyecto: ${items().length}`);
      escribirEnQuick('eq:uno');
      await esperarHasta(() => items()[0]?.includes('eq:uno') === true, 5000, 'el filtro');
      enQuick({ key: 'Enter' });
      await enLinea('cap-uno.tex', 3);
    });

    await paso('el panel Esquema lista las 3 secciones en orden y un clic abre su archivo', async () => {
      store().mostrarPanel('esquema');
      await esperarHasta(() => document.querySelectorAll('.esquema-item').length === 3, 5000, 'las secciones');
      const titulos = [...document.querySelectorAll('.esquema-item .titulo')].map((x) => x.textContent);
      if (titulos.join('|') !== 'Introducción|Primer capítulo|Segundo capítulo') throw new Error(titulos.join('|'));
      document.querySelectorAll<HTMLElement>('.esquema-item')[2].click();
      await enLinea('cap-dos.tex', 1);
    });

    await paso('Ctrl+Shift+F abre Buscar y el resultado coincide con el del core (\\ref{ en 3 archivos, "repetida" 2 veces)', async () => {
      ctrl('f', { shiftKey: true });
      await esperarHasta(() => store().panelIzq === 'buscar', 5000, 'el panel Buscar');
      for (const [query, regex, esperado] of [['\\ref{', false, 3], ['repetida', false, 2], ['\\\\(ref|cite)\\{', true, 6]] as const) {
        store().setBusqueda({ query, regex });
        await store().ejecutarBusqueda();
        const r = store().busqueda.resultado!;
        const directo = await backend.searchProject({ query, regex, caseSensitive: false, wholeWord: false, allFiles: false });
        if (r.total !== directo.total || r.total !== esperado) throw new Error(`«${query}»: la interfaz ${r.total}, el core ${directo.total}, esperado ${esperado}`);
      }
      await esperarHasta(() => document.querySelectorAll('.buscar-coincidencia').length === 6, 5000, 'las filas del resultado');
      store().setBusqueda({ query: 'repetida', regex: false });
      await store().ejecutarBusqueda();
      await esperarHasta(() => document.querySelectorAll('.buscar-archivo').length === 1, 5000, 'el resultado agrupado');
      document.querySelector<HTMLElement>('.buscar-coincidencia')!.click();
      await enLinea('cap-uno.tex', 2);
      const e = getDoc('cap-uno.tex')!;
      const s = e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to);
      if (s !== 'repetida') throw new Error(`la selección es «${s}»`);
    });

    await paso('reemplazar en el proyecto: bytes de disco exactos, la pestaña abierta se relee, y la reversión devuelve el original', async () => {
      const original = await backend.smokeReadBytes('cap-uno.tex');
      const textoOriginal = new TextDecoder().decode(original);
      await store().abrirArchivo('cap-uno.tex');
      store().setBusqueda({ query: 'repetida', reemplazo: 'REPETIDA', conReemplazo: true, caseSensitive: true });
      await store().ejecutarBusqueda();
      await esperarHasta(() => store().busqueda.resultado?.total === 2 && store().busqueda.resultado!.files[0].matches[0].replaced === 'REPETIDA', 5000, 'la vista previa');
      const pendiente = store().reemplazarTodo();
      await esperarHasta(() => store().dialog !== null, 5000, 'la confirmación');
      store().responderDialogo('reemplazar');
      await pendiente;
      const quedo = await backend.smokeReadBytes('cap-uno.tex');
      const dif = iguales(quedo, new TextEncoder().encode(textoOriginal.replaceAll('repetida', 'REPETIDA')));
      if (dif) throw new Error(`bytes tras reemplazar: ${dif}`);
      if (!textoDe('cap-uno.tex')!.includes('REPETIDA REPETIDA')) throw new Error('la pestaña abierta no se releyó');
      // Y de vuelta.
      store().setBusqueda({ query: 'REPETIDA', reemplazo: 'repetida' });
      await store().ejecutarBusqueda();
      const p2 = store().reemplazarTodo();
      await esperarHasta(() => store().dialog !== null, 5000, 'la segunda confirmación');
      store().responderDialogo('reemplazar');
      await p2;
      const dif2 = iguales(await backend.smokeReadBytes('cap-uno.tex'), original);
      if (dif2) throw new Error(`la reversión no devolvió el original: ${dif2}`);
    });

    await paso('reemplazar con la pestaña modificada: se guarda antes (sin perder lo escrito) y los bytes cierran', async () => {
      const original = await backend.smokeReadBytes('cap-uno.tex');
      const textoOriginal = new TextDecoder().decode(original);
      await store().abrirArchivo('cap-uno.tex');
      editarDoc('cap-uno.tex', { from: 0, insert: '% a mano\n' });
      if (!store().tabs.find((t) => t.rel === 'cap-uno.tex')?.dirty) throw new Error('no quedó modificada');
      store().setBusqueda({ query: 'repetida', reemplazo: 'otra', conReemplazo: true, caseSensitive: true });
      await store().ejecutarBusqueda();
      const p = store().reemplazarTodo();
      await esperarHasta(() => store().dialog !== null, 5000, 'la confirmación');
      if (!store().dialog!.detalle?.includes('sin guardar')) throw new Error('el diálogo no avisa de los cambios sin guardar');
      store().responderDialogo('reemplazar');
      await p;
      const dif = iguales(await backend.smokeReadBytes('cap-uno.tex'), new TextEncoder().encode(`% a mano\n${textoOriginal.replaceAll('repetida', 'otra')}`));
      if (dif) throw new Error(`bytes: ${dif}`);
      // Se deja el archivo como estaba.
      const t = textoDe('cap-uno.tex')!;
      editarDoc('cap-uno.tex', { from: 0, to: t.length, insert: textoOriginal });
      await store().guardar('cap-uno.tex', { auto: false });
      const dif2 = iguales(await backend.smokeReadBytes('cap-uno.tex'), original);
      if (dif2) throw new Error(`no se pudo restaurar: ${dif2}`);
      store().setBusqueda({ conReemplazo: false, query: '', caseSensitive: false });
    });

    await paso('keybindings.json de la config del usuario: un atajo nuevo anda, uno quitado deja de andar y uno roto se avisa', async () => {
      await backend.writeUserConfig('keybindings.json', JSON.stringify({ 'formato.negrita': 'Ctrl+Alt+B', 'nav.paleta': null, 'no.existe': 'Ctrl+K' }));
      await cargarKeybindings();
      await store().abrirArchivo('cap-uno.tex');
      const original = textoDe('cap-uno.tex')!;
      const a = posDe('cap-uno.tex', 'palabra');
      moverCursor('cap-uno.tex', a, a + 'palabra'.length);
      tecla({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
      if (!textoDe('cap-uno.tex')!.includes('\\textbf{palabra}')) throw new Error('Ctrl+Alt+B no aplicó negrita');
      restaurar('cap-uno.tex', original);
      moverCursor('cap-uno.tex', a, a + 'palabra'.length);
      ctrl('b');
      if (textoDe('cap-uno.tex') !== original) throw new Error('Ctrl+B sigue aplicando negrita después de moverla');
      ctrl('p', { shiftKey: true });
      await dormir(200);
      if (hayQuick()) throw new Error('la paleta se abrió aunque se le quitó el atajo');
      if (!store().notice?.texto.includes('no.existe')) throw new Error(`no se avisó del comando inexistente: ${store().notice?.texto}`);
      detalle(store().notice?.texto ?? "");
      // Se vuelve a los atajos de fábrica y se deja el archivo de config vacío.
      await backend.writeUserConfig('keybindings.json', '{}');
      aplicarKeybindings(null);
      await cargarKeybindings();
      moverCursor('cap-uno.tex', a, a + 'palabra'.length);
      ctrl('b');
      if (!textoDe('cap-uno.tex')!.includes('\\textbf{palabra}')) throw new Error('Ctrl+B no volvió');
      restaurar('cap-uno.tex', original);
    });
  })();

  const tope = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tope de tiempo')), 4 * 60 * 1000));
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
