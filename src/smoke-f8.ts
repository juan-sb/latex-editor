// Smoke de aceptación de F8 (`LV_SMOKE=f8`). Corre sola, dentro de la app real con TeX de verdad, sobre una copia tibia del libro SIN la
// guardia a `\OpcionPie` (`scripts/aceptacion-f8.ps1` la arma, deja un `pdflatex` huérfano andando en la carpeta y después abre una
// SEGUNDA instancia de la app sobre el mismo proyecto). Sirve para las dos: con `LV_SMOKE_FILE=segunda` corre el papel de la segunda.
//
// Primera instancia:
//   - toma el candado `.lv/lock` con su PID,
//   - al abrir ofrece matar el pdflatex huérfano de antes (y lo mata),
//   - el doctor corre al abrir y encuentra el `\def\OpcionPie` incondicional del libro sin parchear, sin errores,
//   - un build, una cocción, una exportación, una vista previa de fragmento, un build por guardado y un build por un archivo cambiado
//     afuera: el historial tiene UNA línea por cada trabajo de la cola, con su motivo.
// Segunda instancia: ve el candado, avisa, no pregunta por huérfanos, no compila ni cocina y sigue pudiendo abrir archivos.
import { getBackend, PERFIL_EXPORT, PERFIL_FRAGMENTO, type BuildEvent, type EntradaHistorial, type LaunchOptions } from './backend';
import { editarDoc, moverCursor, textoDe } from './editor/docs';
import { dormir, esperarHasta, puntoDeInsercion } from './smoke-util';
import { useApp } from './store/app';

const LIMITE_MS = 6 * 60 * 1000;
const PARTE = 'Secciones/Desnormalización';
const ARCHIVO_PARTE = 'Secciones/Desnormalización.tex';
const ARCHIVO_FRAGMENTO = 'Secciones/Aproximación de Butterworth.tex';

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF8(opts: LaunchOptions): Promise<void> {
  const backend = getBackend();
  const store = () => useApp.getState();
  const segunda = opts.smokeFile === 'segunda';
  const pasos: Paso[] = [];
  const datos: Record<string, unknown> = { arranqueMs: Math.round(performance.now()), instancia: segunda ? 'segunda' : 'primera' };
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
  const desde = () => eventos.length;
  const fin = (n: number, perfil: string) => eventos.slice(n).find((e) => e.type === 'finished' && e.perfil === perfil);
  const ocioso = () => store().build.status !== 'running' && store().exportando === null && store().figProgreso === null;
  const esperarOcioso = async (que: string) => {
    await dormir(500);
    await esperarHasta(ocioso, LIMITE_MS, que);
    await dormir(600);
  };
  const lock = async (): Promise<{ pid: number }> => JSON.parse((await backend.readFile('.lv/lock')).text) as { pid: number };

  const primera = async () => {
    await paso('proyecto abierto con su candado: .lv/lock lleva el PID de esta instancia y la vista no dice que esté bloqueado', async () => {
      const p = store().project;
      if (!p?.config) throw new Error('no hay proyecto con configuración');
      if (p.lockedBy !== null) throw new Error(`el proyecto figura bloqueado por ${p.lockedBy}`);
      const l = await lock();
      if (!(l.pid > 0)) throw new Error(`candado sin PID: ${JSON.stringify(l)}`);
      datos.pidDelCandado = l.pid;
      detalle(`candado de PID ${l.pid}`);
    });

    await paso('al abrir: un pdflatex que quedó de antes en este proyecto se ofrece y se mata, y no queda ninguno', async () => {
      const pid = Number((await backend.readFile('.lv/f8-pid.txt')).text.trim());
      await esperarHasta(() => store().dialog !== null, 20000, 'el aviso de procesos huérfanos');
      const d = store().dialog!;
      if (!/proceso/.test(d.mensaje) || !(d.detalle ?? '').includes(`PID ${pid}`)) throw new Error(`el aviso no nombra el pdflatex ${pid}: ${d.mensaje} | ${d.detalle}`);
      const t0 = Date.now();
      store().responderDialogo('matar');
      await esperarHasta(() => store().dialog === null, 5000, 'que se cierre el aviso');
      await esperarHasta(() => store().notice?.texto.startsWith('Se mataron') === true, 20000, 'el aviso de que se mataron');
      datos.matarHuerfanosMs = Date.now() - t0;
      const t1 = Date.now();
      const quedan = await backend.orphans();
      datos.huerfanosMs = Date.now() - t1;
      if (quedan.length > 0) throw new Error(`quedan ${quedan.length}: ${quedan.map((q) => `${q.nombre} ${q.pid}`).join(', ')}`);
      detalle(`PID ${pid}: «${d.detalle}»; ${datos.matarHuerfanosMs} ms en matarlo, buscar huérfanos tarda ${datos.huerfanosMs} ms`);
    });

    await paso('el doctor corrió al abrir: encuentra el \\def\\OpcionPie sin guardia del libro, sin errores', async () => {
      await esperarHasta(() => store().doctor !== null, 60000, 'el doctor');
      const inf = store().doctor!;
      datos.doctorMs = inf.ms;
      datos.doctorDistribucion = inf.distribucion;
      datos.doctor = inf.hallazgos.map((h) => `${h.nivel} ${h.id}: ${h.titulo}`);
      const errores = inf.hallazgos.filter((h) => h.nivel === 'error');
      if (errores.length > 0) throw new Error(`errores del doctor: ${errores.map((h) => h.titulo).join(' | ')}`);
      const v = inf.hallazgos.find((h) => h.id === 'variable-def');
      if (!v || v.nivel !== 'aviso' || !v.titulo.includes('OpcionPie') || v.archivo !== 'structure.tex') throw new Error(`falta el aviso de OpcionPie: ${JSON.stringify(v)}`);
      if (!v.arreglo?.includes('\\ifdefined\\OpcionPie')) throw new Error(`el aviso no dice cómo arreglarlo: ${v.arreglo}`);
      for (const id of ['motor', 'nucleo', 'latexmk', 'perl']) {
        if (!inf.hallazgos.some((h) => h.id === id && h.nivel === 'ok')) throw new Error(`el doctor no dio ok a «${id}»`);
      }
      if (inf.hallazgos.some((h) => h.id === 'huerfanos')) throw new Error('el doctor todavía ve huérfanos');
      // El libro define \Capitulo con \include (y con \input sólo para la cocción): no es una parte por \input.
      if (inf.hallazgos.some((h) => h.id === 'parte-por-input')) throw new Error('el doctor da por \\input las partes del libro, que entran por \\include');
      // Dentro de latexmk el PATH de MiKTeX 26.5 queda reducido: el doctor lo ve (con el `latexmkrc` del libro es un aviso).
      const path = inf.hallazgos.find((h) => h.id === 'path-latexmk');
      if (!path || path.titulo.includes('No se pudo leer')) throw new Error(`el doctor no leyó el PATH de latexmk: ${JSON.stringify(path)}`);
      detalle(`${inf.distribucion}, ${inf.hallazgos.length} hallazgos en ${inf.ms} ms; ${v.archivo}:${v.linea}`);
    });

    await paso('el panel Doctor y el panel Historial se ven con su contenido', async () => {
      store().mostrarPanelInferior('doctor');
      await esperarHasta(() => document.querySelectorAll('.doctor .hallazgo').length > 3, 5000, 'los hallazgos en el panel');
      if (!document.querySelector('.doctor .hallazgo.aviso')) throw new Error('el panel no muestra el aviso');
      const pestana = [...document.querySelectorAll('.inferior-pestanas button')].find((b) => b.textContent?.startsWith('Doctor'));
      if (!pestana?.querySelector('.contador')) throw new Error('la pestaña Doctor no lleva el contador de avisos');
      store().mostrarPanelInferior('historial');
      await dormir(300);
      if (!document.querySelector('.historial')) throw new Error('no se ve el panel Historial');
    });

    await paso('perfil parcial de una parte: un build manual, una cocción de todo, una exportación y una vista previa de fragmento', async () => {
      await store().setAutoCompile('manual');
      await store().soloParte(PARTE);
      await store().elegirPerfil('parcial');
      const n = desde();
      await store().compilar('parcial', { guardar: false });
      await esperarHasta(() => fin(n, 'parcial') !== undefined, LIMITE_MS, 'el parcial');
      const f = fin(n, 'parcial')!;
      if (f.type !== 'finished' || !f.ok) throw new Error('el parcial no compiló');
      await esperarOcioso('el final del parcial');
      const nb = desde();
      await store().cocinarFiguras();
      await esperarHasta(() => eventos.slice(nb).some((e) => e.type === 'bakefinished'), LIMITE_MS, 'la cocción');
      await esperarOcioso('el final de la cocción');
      const ne = desde();
      await store().exportarPartes([PARTE]);
      await esperarHasta(() => eventos.slice(ne).some((e) => e.type === 'exportfinished'), LIMITE_MS, 'la exportación');
      await esperarOcioso('el final de la exportación');
      await store().abrirArchivo(ARCHIVO_FRAGMENTO);
      const texto = textoDe(ARCHIVO_FRAGMENTO)!;
      const i = texto.indexOf('\\begin{tikzpicture}');
      if (i < 0) throw new Error('no encontré una figura en el capítulo');
      moverCursor(ARCHIVO_FRAGMENTO, texto.indexOf('\\draw', i));
      const nf = desde();
      await store().previsualizarFragmento();
      await esperarHasta(() => fin(nf, PERFIL_FRAGMENTO) !== undefined, LIMITE_MS, 'el fragmento');
      await esperarOcioso('el final del fragmento');
      store().mostrarVista('pdf');
    });

    await paso('guardar un archivo con la compilación al guardar dispara un build con el motivo «guardado: …»', async () => {
      await store().setAutoCompile('save');
      await store().abrirArchivo(ARCHIVO_PARTE);
      const n = desde();
      editarDoc(ARCHIVO_PARTE, { from: puntoDeInsercion(textoDe(ARCHIVO_PARTE)!, 0), to: puntoDeInsercion(textoDe(ARCHIVO_PARTE)!, 0), insert: 'f8a ' });
      await store().guardar(ARCHIVO_PARTE);
      await esperarHasta(() => fin(n, 'parcial') !== undefined, LIMITE_MS, 'el build por guardado');
      await esperarOcioso('el final del build por guardado');
      const h = await backend.history(1);
      if (h[0]?.tipo !== 'build' || h[0].motivo !== `guardado: ${ARCHIVO_PARTE}`) throw new Error(`motivo del build: ${h[0]?.tipo} ${h[0]?.motivo}`);
      detalle(`«${h[0].motivo}», ${h[0].ms} ms`);
    });

    await paso('un archivo cambiado afuera dispara un build con el motivo «afuera: …»', async () => {
      const n = desde();
      const leido = await backend.readFile(ARCHIVO_PARTE);
      const t = leido.text;
      const i = puntoDeInsercion(t, 1);
      await backend.writeFile(ARCHIVO_PARTE, `${t.slice(0, i)}f8b ${t.slice(i)}`, leido.version);
      await esperarHasta(() => fin(n, 'parcial') !== undefined, LIMITE_MS, 'el build por el cambio de afuera');
      await esperarOcioso('el final del build por el cambio de afuera');
      const h = await backend.history(1);
      if (h[0]?.tipo !== 'build' || !h[0].motivo.startsWith('afuera: ') || !h[0].motivo.includes('Desnormalización.tex')) throw new Error(`motivo del build: ${h[0]?.tipo} ${h[0]?.motivo}`);
      detalle(`«${h[0].motivo}», ${h[0].ms} ms`);
    });

    await paso('el historial tiene una línea por cada trabajo de la cola, con sus pistas y su motivo', async () => {
      const lineas: EntradaHistorial[] = await backend.history(200);
      // Los trabajos de la cola que terminaron, según los eventos: un build por cada `finished` de un perfil que no es el de
      // exportar (cada parte exportada es un build de servicio, pero la exportación es UN trabajo), una cocción por cada `bakefinished`
      // y una exportación por cada `exportfinished`.
      const esperadas = {
        build: eventos.filter((e) => e.type === 'finished' && e.perfil !== PERFIL_EXPORT && e.perfil !== PERFIL_FRAGMENTO).length,
        fragment: eventos.filter((e) => e.type === 'finished' && e.perfil === PERFIL_FRAGMENTO).length,
        bake: eventos.filter((e) => e.type === 'bakefinished').length,
        export: eventos.filter((e) => e.type === 'exportfinished').length,
      };
      const cuantas = (t: string) => lineas.filter((l) => l.tipo === t).length;
      const obtenidas = { build: cuantas('build'), fragment: cuantas('fragment'), bake: cuantas('bake'), export: cuantas('export') };
      datos.historialEsperado = esperadas;
      datos.historialObtenido = obtenidas;
      if (JSON.stringify(esperadas) !== JSON.stringify(obtenidas)) throw new Error(`líneas por tipo: esperadas ${JSON.stringify(esperadas)}, hay ${JSON.stringify(obtenidas)}`);
      for (const t of ['build', 'bake', 'export', 'fragment']) if (obtenidas[t as keyof typeof obtenidas] === 0) throw new Error(`no hay ninguna línea de «${t}»`);
      const motivos = new Set(lineas.map((l) => l.motivo.split(':')[0]));
      for (const m of ['manual', 'guardado', 'afuera']) if (!motivos.has(m)) throw new Error(`ningún trabajo con el motivo «${m}»: ${[...motivos].join(', ')}`);
      const build = lineas.find((l) => l.tipo === 'build');
      if (!build?.herramientas?.some((h) => h.nombre === 'pdflatex') || !build.pasadas) throw new Error(`el build no tiene herramientas ni pasadas: ${JSON.stringify(build)}`);
      const export_ = lineas.find((l) => l.tipo === 'export')!;
      if (!export_.partes?.some((p) => p.parte === PARTE && p.ok && p.num)) throw new Error(`la exportación no tiene su parte con número: ${JSON.stringify(export_.partes)}`);
      // El panel lo muestra, con las pistas.
      store().mostrarPanelInferior('historial');
      await esperarHasta(() => document.querySelectorAll('.historial .hist-fila').length === lineas.length, 5000, 'las filas del panel');
      datos.historialPistas = lineas.slice(0, 8).map((l) => `${l.tipo} ${l.motivo} ${l.ms} ms: ${l.pistas.join(' / ')}`);
      datos.historial = lineas.map((l) => ({ tipo: l.tipo, perfil: l.perfil, motivo: l.motivo, ms: l.ms, ok: l.ok, pistas: l.pistas }));
      detalle(`${lineas.length} líneas: ${JSON.stringify(obtenidas)}`);
    });

    await paso('la segunda instancia (la lanza el script) no pisa el candado de esta', async () => {
      const yo = (await lock()).pid;
      await backend.writeFile('.lv/f8-listo.txt', `${Date.now()}\n`, null);
      const t0 = Date.now();
      for (;;) {
        try {
          await backend.readFile('.lv/f8-segunda.txt');
          break;
        } catch {
          if (Date.now() - t0 > 3 * 60 * 1000) throw new Error('la segunda instancia no terminó');
          await dormir(500);
        }
      }
      if ((await lock()).pid !== yo) throw new Error('el candado cambió de dueño');
      if (store().project?.lockedBy !== null) throw new Error('esta instancia figura bloqueada');
      detalle(`el candado sigue siendo del PID ${yo}`);
    });
  };

  const segundaInstancia = async () => {
    await paso('abre el proyecto y la vista dice quién lo tiene: el PID que está en .lv/lock', async () => {
      const p = store().project;
      if (!p?.config) throw new Error('no hay proyecto');
      const dueno = (await lock()).pid;
      if (p.lockedBy !== dueno) throw new Error(`lockedBy ${p.lockedBy}, el candado es de ${dueno}`);
      datos.duenoDelCandado = dueno;
      detalle(`bloqueado por el PID ${dueno}`);
    });
    await paso('avisa que está abierto en otra instancia y no pregunta por huérfanos ni corre el doctor', async () => {
      await esperarHasta(() => store().notice !== null, 20000, 'el aviso');
      const n = store().notice!;
      if (n.nivel !== 'error' || !/otra instancia/.test(n.texto) || !n.texto.includes(`PID ${datos.duenoDelCandado}`)) throw new Error(`aviso: ${n.texto}`);
      await dormir(1500);
      if (store().dialog !== null) throw new Error('preguntó por huérfanos');
      if (store().doctor !== null) throw new Error('corrió el doctor');
      detalle(n.texto);
    });
    await paso('no compila ni cocina ni exporta: cada intento avisa con el PID y no deja nada corriendo', async () => {
      await store().setAutoCompile('manual');
      await store().compilar('rapido', { guardar: false });
      if (!/PID/.test(store().notice?.texto ?? '') || store().build.status !== 'idle') throw new Error(`compilar: ${store().notice?.texto} / ${store().build.status}`);
      store().cerrarAviso();
      await store().cocinarFiguras();
      if (!/PID/.test(store().notice?.texto ?? '') || store().figProgreso !== null) throw new Error(`cocinar: ${store().notice?.texto}`);
      store().cerrarAviso();
      await store().exportarPartes([PARTE]);
      if (!/PID/.test(store().notice?.texto ?? '') || store().exportando !== null) throw new Error(`exportar: ${store().notice?.texto}`);
      if (!ocioso()) throw new Error('quedó algo corriendo');
      if (eventos.some((e) => e.type === 'started')) throw new Error('arrancó un build');
    });
    await paso('editar sigue andando: abre un archivo y arma el índice de símbolos', async () => {
      await store().abrirArchivo(ARCHIVO_PARTE);
      if (!textoDe(ARCHIVO_PARTE)) throw new Error('no abrió el archivo');
      await store().cargarSimbolos();
      if (!store().simbolos) throw new Error('sin símbolos');
    });
    await paso('al terminar no tocó el candado del dueño', async () => {
      if ((await lock()).pid !== datos.duenoDelCandado) throw new Error('el candado cambió');
    });
  };

  const trabajo = segunda ? segundaInstancia() : primera();
  const tope = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tope de tiempo')), LIMITE_MS * 3));
  try {
    await Promise.race([trabajo, tope]);
  } catch (e) {
    fallo = e instanceof Error ? e.message : String(e);
  }
  const resultado = { ok: fallo === null && pasos.every((p) => p.ok), fallo, pasos, ...datos };
  try {
    await backend.writeSmokeResult(JSON.stringify(resultado, null, 2));
    // La segunda instancia deja su resultado en su propio `LV_SMOKE_OUT`; la marca `.lv/f8-segunda.txt` la pone el script al verla terminar.
    if (opts.smokePausaMs > 0) await dormir(opts.smokePausaMs);
  } finally {
    await backend.exitApp();
  }
}
