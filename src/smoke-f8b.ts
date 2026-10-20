// Smoke de aceptación de F8b (`LV_SMOKE=f8b`). Corre sola, dentro de la app real con TeX de verdad, sobre una copia tibia del libro SIN
// `latexviewer.json` (`scripts/aceptacion-f8b.ps1` la arma, sin parchear nada y con el cache de figuras tibio):
//   - la pantalla Proyecto se abre sola, detecta el documento del libro (y las 4 raíces auxiliares), las partes y la macro \Capitulo,
//   - «Probar» lista las 8 figuras de Butterworth con la configuración propuesta, sin guardarla,
//   - sólo confirmando (Guardar y Confirmar) se escribe `latexviewer.json`; el script compara ese archivo con el de `fixtures/configs/`,
//   - con esa configuración el parcial con Butterworth compila y la barra va mostrando la etiqueta, la pasada y la herramienta,
//   - la raíz ya no está en la barra ni en `state.json`: un `state.json` con `cap_actual.tex` no pisa a la del proyecto al reabrir.
import { getBackend, type LaunchOptions } from './backend';
import { dormir, esperarHasta } from './smoke-util';
import { useApp } from './store/app';
import { useProyecto } from './store/proyecto';

const LIMITE_MS = 6 * 60 * 1000;
const PARTE = 'Secciones/Aproximación de Butterworth';
const RAIZ = 'Funciones de Aproximación.tex';

interface Paso {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export async function correrSmokeF8b(opts: LaunchOptions): Promise<void> {
  const backend = getBackend();
  const store = () => useApp.getState();
  const proyecto = () => useProyecto.getState();
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

  const trabajo = (async () => {
    await paso('la pantalla Proyecto se abre sola, sin latexviewer.json, con todas sus secciones', async () => {
      const t0 = Date.now();
      await esperarHasta(() => proyecto().abierta && !proyecto().cargando && proyecto().config !== null, 60000, 'la pantalla Proyecto');
      datos.detectarMs = Date.now() - t0;
      if (!proyecto().alAbrir) throw new Error('no se marcó como abierta sola');
      if (proyecto().textoDisco !== null) throw new Error('el proyecto tenía un latexviewer.json');
      await esperarHasta(() => document.querySelectorAll('.proyecto-pantalla .proy-seccion').length >= 9, 5000, 'las secciones');
      const titulos = [...document.querySelectorAll('.proyecto-pantalla .proy-seccion h3')].map((h) => h.textContent);
      for (const t of ['Documento principal', 'Partes', 'Compilación reducida', 'Figuras', 'Perfiles', 'Salidas', 'Variables', 'Avanzado', 'Probar']) {
        if (!titulos.includes(t)) throw new Error(`falta la sección «${t}»: ${titulos.join(', ')}`);
      }
      detalle(`${titulos.length} secciones; la detección tardó ${datos.detectarMs} ms con el arranque`);
    });

    await paso('detecta el documento principal, las raíces auxiliares, las 8 partes y la macro \\Capitulo', async () => {
      const p = proyecto().propuesta!;
      if (p.raiz !== RAIZ) throw new Error(`raíz propuesta: ${p.raiz}`);
      const roles = Object.fromEntries(p.candidatas.map((c) => [c.archivo, c.rol]));
      for (const aux of ['cap_actual.tex', 'libro_fast.tex', 'libro_cocina.tex', 'libro_export.tex']) {
        if (roles[aux] !== 'auxiliar') throw new Error(`${aux} debía ser una raíz auxiliar y es ${roles[aux]}`);
      }
      if (!p.candidatas.find((c) => c.archivo === RAIZ)?.recomendada) throw new Error('el documento del libro no figura como recomendado');
      if (p.partes.length !== 8) throw new Error(`partes: ${p.partes.length}`);
      if (p.partsCommands.join() !== 'include,Capitulo') throw new Error(`comandos de parte: ${p.partsCommands.join()}`);
      const elegida = document.querySelector<HTMLInputElement>('.proy-candidata.elegida input')?.closest('label')?.textContent ?? '';
      if (!elegida.includes(RAIZ)) throw new Error(`en pantalla está elegida: ${elegida}`);
      const flags = Object.fromEntries(p.flags.map((f) => [f.nombre, f.uso]));
      if (flags.CompilacionReducida !== 'partial' || flags.TikzExternalizar !== 'externalize' || flags.TikzListaYMake !== 'figureList') throw new Error(`flags: ${JSON.stringify(flags)}`);
      if (p.figuras.modo !== 'project' || p.figuras.dir !== 'figuras-cache' || p.figuras.stampFiles.join() !== 'estilo_figuras.tex') throw new Error(`figuras: ${JSON.stringify(p.figuras)}`);
      const v = p.variables.find((x) => x.nombre === 'OpcionPie');
      if (!v || v.choices.join() !== 'completo,autor,ninguno' || v.defSinGuardia.length === 0) throw new Error(`variable OpcionPie: ${JSON.stringify(v)}`);
      detalle(`${p.candidatas.length} candidatas, ${p.partes.length} partes; OpcionPie sin guardia en ${v.defSinGuardia[0].archivo}:${v.defSinGuardia[0].linea}`);
    });

    await paso('Probar: lista las figuras de Butterworth con la configuración propuesta, sin guardarla', async () => {
      const t0 = Date.now();
      await proyecto().probar(PARTE);
      datos.probarMs = Date.now() - t0;
      const r = proyecto().probada;
      if (!r || proyecto().errorDeProbar) throw new Error(`probar: ${proyecto().errorDeProbar}`);
      if (r.listado.omitido || r.listado.figuras !== 8) throw new Error(`listado: ${JSON.stringify(r.listado)}`);
      if (r.doctor.hallazgos.some((h) => h.nivel === 'error')) throw new Error('el doctor dio errores');
      if ((await backend.configOnDisk()) !== null) throw new Error('probar escribió latexviewer.json');
      detalle(`${r.listado.figuras} figuras de «${PARTE.split('/').pop()}» en ${r.listado.ms} ms; doctor ${r.doctor.ms} ms; en total ${datos.probarMs} ms`);
    });

    await paso('sólo confirmando: Guardar muestra el diff y Confirmar escribe latexviewer.json con lo detectado', async () => {
      const esperado = proyecto().propuesta!.texto;
      await proyecto().pedirGuardar();
      if (proyecto().paso !== 'confirmar') throw new Error(`no pasó a confirmar: ${proyecto().validacion?.errores.join('; ')}`);
      await esperarHasta(() => document.querySelector('.proy-diff') !== null, 5000, 'el diff en pantalla');
      if (!proyecto().diff.every((l) => l.tipo === 'agrega')) throw new Error('el diff de un archivo nuevo debía ser todo «agrega»');
      if (!(await proyecto().confirmarGuardado())) throw new Error(`no se escribió: ${proyecto().error}`);
      const enDisco = await backend.configOnDisk();
      if (enDisco !== esperado) throw new Error('lo escrito no es la propuesta');
      if (proyecto().abierta) throw new Error('la pantalla quedó abierta');
      const p = store().project!;
      if (!p.configSaved || p.rootFile !== RAIZ || p.parts.length !== 8) throw new Error(`proyecto después de guardar: ${JSON.stringify({ g: p.configSaved, r: p.rootFile, n: p.parts.length })}`);
      const ids = p.config!.profiles.map((x) => x.id).join();
      if (ids !== 'parcial,rapido,completo,entrega') throw new Error(`perfiles: ${ids}`);
      detalle(`escrito (${enDisco.length} bytes); perfiles ${ids}`);
    });

    await paso('la barra ya no tiene la raíz: es un botón que abre la pantalla Proyecto', async () => {
      const etiquetas = [...document.querySelectorAll('.barra-superior label')].map((l) => l.textContent ?? '');
      if (etiquetas.some((t) => t.trim().startsWith('Raíz'))) throw new Error(`todavía hay un selector de raíz: ${etiquetas.join(' | ')}`);
      const boton = document.querySelector<HTMLButtonElement>('.barra-superior .raiz-actual');
      if (!boton || !(boton.textContent ?? '').includes(RAIZ)) throw new Error(`botón de la raíz: ${boton?.textContent}`);
      boton.click();
      await esperarHasta(() => proyecto().abierta && !proyecto().cargando, 20000, 'la pantalla desde la barra');
      if (proyecto().alAbrir || proyecto().textoDisco === null) throw new Error('debía abrirse con el archivo del disco');
      proyecto().cerrar();
    });

    await paso('el parcial con Butterworth compila con la configuración guardada y la barra muestra etiqueta, pasada y herramienta', async () => {
      await store().setAutoCompile('manual');
      await store().soloParte(PARTE);
      await store().elegirPerfil('parcial');
      const vistos = new Set<string>();
      let etiquetaOk = true;
      let figuraVista = false;
      const t0 = Date.now();
      await store().compilar('parcial', { guardar: false });
      while ((store().build.status === 'running' || store().figProgreso !== null) && Date.now() - t0 < LIMITE_MS) {
        const estado = document.querySelector('.estado-build')?.textContent ?? '';
        if (store().build.status === 'running') {
          const m = /pasada \d+ · \w+latex|biber|makeindex/.exec(estado);
          if (m) vistos.add(m[0]);
          if (store().build.id !== null && estado.includes('«parcial')) etiquetaOk = false; // el id en lugar de la etiqueta
          if (/cocinando figura \d+: /.test(estado)) figuraVista = true;
        }
        await dormir(150);
      }
      if (store().build.status !== 'ok') throw new Error(`el parcial terminó ${store().build.status}`);
      if (!etiquetaOk) throw new Error('la barra mostró el id del perfil en lugar de su etiqueta');
      if (![...vistos].some((v) => v.startsWith('pasada 1'))) throw new Error(`nunca se vio «pasada 1 · pdflatex» en la barra: ${[...vistos].join(', ')}`);
      const sel = document.querySelector<HTMLSelectElement>('.barra-superior select[title^="Lo que compila"]');
      if (!sel || ![...sel.options].some((o) => o.textContent === 'Partes elegidas')) throw new Error('el selector de perfil no muestra la etiqueta');
      datos.parcialMs = store().build.ms;
      datos.pasosVistos = [...vistos];
      datos.figuraVistaEnLaBarra = figuraVista;
      detalle(`parcial en ${store().build.ms} ms; la barra mostró: ${[...vistos].join(', ')}${figuraVista ? '; y la figura que cocina pgf' : ''}`);
    });

    await paso('el historial dice que el parcial cocinó antes las figuras (sin lista que valga) y el típico se carga', async () => {
      const h = await backend.history(10);
      const build = h.find((x) => x.tipo === 'build' && x.perfil === 'parcial');
      if (!build) throw new Error('sin línea del build');
      const bake = h.find((x) => x.tipo === 'bake');
      datos.historial = h.map((x) => `${x.tipo} ${x.perfil ?? ''} ${x.motivo} ${x.ms} ms: ${x.pistas.join(' / ')}`);
      await store().cargarTipicos();
      if (!store().tipicos.parcial) throw new Error('el típico del parcial no se cargó');
      detalle(`${bake ? `bake «${bake.motivo}»` : 'sin bake'}; típico del parcial ${store().tipicos.parcial.ms} ms (${store().tipicos.parcial.n})`);
    });

    await paso('un state.json con otra raíz no pisa a la del proyecto: al reabrir manda latexviewer.json', async () => {
      const carpeta = store().project!.root;
      const estado = JSON.parse((await backend.readFile('.lv/state.json')).text) as Record<string, unknown>;
      await backend.writeFile('.lv/state.json', JSON.stringify({ ...estado, root: 'cap_actual.tex' }, null, 2), (await backend.readFile('.lv/state.json')).version);
      await store().abrirProyecto(carpeta);
      if (store().rootFile !== RAIZ) throw new Error(`al reabrir la raíz es ${store().rootFile}`);
      if (proyecto().abierta) throw new Error('la pantalla se abrió con un proyecto que ya tiene configuración');
      detalle(`raíz al reabrir: ${store().rootFile}`);
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
