// Registro de comandos de la app y despachador de teclado. Cada comando tiene un id estable (el que se usa en el
// `keybindings.json` del usuario), un título para la paleta y sus atajos por defecto (10.3 del plan). El despachador
// es el único que atiende el teclado de la ventana: frena lo que WebView2 haría por su cuenta (imprimir con Ctrl+P, recargar
// con F5 y Ctrl+R) y lo que CodeMirror usa con otro sentido (Ctrl+M, Ctrl+Enter, Alt+←).
import { abrirBusquedaEnArchivo, aplicarEnVista } from '../editor/docs';
import { aplicarFormato, type NombreFormato } from '../editor/formato';
import { getBackend } from '../backend';
import { useApp } from '../store/app';
import { buscarPorEvento, esNativoPeligroso, formatoAtajo, resolverAtajos, type AtajosPorId, type AtajosResueltos } from './atajos';

export interface Comando {
  id: string;
  titulo: string;
  categoria: string;
  atajos: string[];
  /** Sólo tiene sentido con el foco en el editor: no se atiende si el foco está en un campo de texto de otro panel. */
  soloEditor?: boolean;
  ejecutar: () => void | Promise<void>;
}

const app = () => useApp.getState();

const formato = (id: string, titulo: string, atajos: string[], f: NombreFormato): Comando => ({
  id: `formato.${id}`,
  titulo,
  categoria: 'Formato',
  atajos,
  soloEditor: true,
  ejecutar: () => void aplicarEnVista((s) => aplicarFormato(s, f)),
});

/** Todos los comandos. El orden importa: ante un atajo repetido gana el primero. */
export const COMANDOS: Comando[] = [
  { id: 'archivo.guardar', titulo: 'Guardar', categoria: 'Archivo', atajos: ['Ctrl+S'], ejecutar: () => void app().guardar() },
  { id: 'archivo.guardarTodo', titulo: 'Guardar todo', categoria: 'Archivo', atajos: [], ejecutar: () => void app().guardarTodo() },
  { id: 'archivo.cerrarPestana', titulo: 'Cerrar la pestaña', categoria: 'Archivo', atajos: ['Ctrl+W'], ejecutar: () => void (app().activeRel && app().cerrarTab(app().activeRel!)) },
  { id: 'archivo.pestanaSiguiente', titulo: 'Pestaña siguiente', categoria: 'Archivo', atajos: ['Ctrl+Tab', 'Ctrl+PageDown'], ejecutar: () => app().pestanaSiguiente(1) },
  { id: 'archivo.pestanaAnterior', titulo: 'Pestaña anterior', categoria: 'Archivo', atajos: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], ejecutar: () => app().pestanaSiguiente(-1) },

  { id: 'build.compilar', titulo: 'Compilar el perfil activo', categoria: 'Compilación', atajos: ['Ctrl+Enter'], ejecutar: () => void app().compilar() },
  // Ctrl+Mayús+Enter es el de F2; Ctrl+Alt+C es el del plan (10.3).
  { id: 'build.compilarParte', titulo: 'Compilar la parte del archivo abierto', categoria: 'Compilación', atajos: ['Ctrl+Alt+C', 'Ctrl+Shift+Enter'], ejecutar: () => void app().compilarParteActiva() },
  { id: 'build.cancelar', titulo: 'Cancelar la compilación', categoria: 'Compilación', atajos: [], ejecutar: () => void app().cancelarBuild() },
  { id: 'build.publicar', titulo: 'Publicar el PDF', categoria: 'Compilación', atajos: [], ejecutar: () => void app().publicar() },
  // F7: el menú de compilación de 10.3 (como el Ctrl+Alt+T de inspo), exportar y la vista previa de un fragmento.
  { id: 'build.menu', titulo: 'Menú de compilación: perfiles, variables, exportar, cocinar y limpiar', categoria: 'Compilación', atajos: ['Ctrl+Alt+T'], ejecutar: () => app().menuCompilacion() },
  { id: 'build.exportarParte', titulo: 'Exportar la parte del archivo abierto a PDF', categoria: 'Compilación', atajos: [], ejecutar: () => void app().exportarParteActiva() },
  { id: 'build.exportarElegidas', titulo: 'Exportar las partes elegidas a PDF', categoria: 'Compilación', atajos: [], ejecutar: () => void app().exportarPartes(app().project?.state.selection) },
  { id: 'build.exportarTodas', titulo: 'Exportar todas las partes a PDF', categoria: 'Compilación', atajos: [], ejecutar: () => void app().exportarPartes() },
  { id: 'fragmento.vistaPrevia', titulo: 'Vista previa del fragmento (selección o entorno actual)', categoria: 'Compilación', atajos: ['Ctrl+Alt+F'], ejecutar: () => void app().previsualizarFragmento() },
  { id: 'vista.layout', titulo: 'Alternar el layout (editor y PDF, sólo editor, sólo PDF)', categoria: 'Vista', atajos: ['Ctrl+\\'], ejecutar: () => app().alternarLayout() },
  { id: 'problemas.siguiente', titulo: 'Problema siguiente', categoria: 'Compilación', atajos: ['F8'], ejecutar: () => void app().saltarProblema(1) },
  { id: 'problemas.anterior', titulo: 'Problema anterior', categoria: 'Compilación', atajos: ['Shift+F8'], ejecutar: () => void app().saltarProblema(-1) },

  { id: 'sync.irAlPdf', titulo: 'Del código al PDF (SyncTeX)', categoria: 'Navegación', atajos: ['Ctrl+Alt+J'], ejecutar: () => void app().irAlPdf() },
  { id: 'nav.definicion', titulo: 'Ir a la definición', categoria: 'Navegación', atajos: ['F12'], soloEditor: true, ejecutar: () => void app().irADefinicion() },
  { id: 'nav.usos', titulo: 'Dónde se usa (etiqueta o cita)', categoria: 'Navegación', atajos: ['Shift+F12'], soloEditor: true, ejecutar: () => void app().mostrarUsos() },
  { id: 'nav.atras', titulo: 'Volver al lugar anterior', categoria: 'Navegación', atajos: ['Alt+Left'], ejecutar: () => void app().atras() },
  { id: 'nav.adelante', titulo: 'Avanzar al lugar siguiente', categoria: 'Navegación', atajos: ['Alt+Right'], ejecutar: () => void app().adelante() },
  { id: 'nav.abrirArchivo', titulo: 'Abrir archivo…', categoria: 'Navegación', atajos: ['Ctrl+P'], ejecutar: () => void app().abrirArchivoRapido() },
  { id: 'nav.paleta', titulo: 'Paleta de comandos', categoria: 'Navegación', atajos: ['Ctrl+Shift+P'], ejecutar: () => abrirPaleta() },
  { id: 'nav.seccionArchivo', titulo: 'Ir a sección o etiqueta de este archivo', categoria: 'Navegación', atajos: ['Ctrl+Shift+O'], ejecutar: () => void app().irASeccion('archivo') },
  { id: 'nav.seccionProyecto', titulo: 'Ir a sección o etiqueta del proyecto', categoria: 'Navegación', atajos: ['Ctrl+T'], ejecutar: () => void app().irASeccion('proyecto') },

  { id: 'buscar.archivo', titulo: 'Buscar en el archivo', categoria: 'Buscar', atajos: ['Ctrl+F'], soloEditor: true, ejecutar: () => void abrirBusquedaEnArchivo() },
  { id: 'buscar.reemplazarArchivo', titulo: 'Reemplazar en el archivo', categoria: 'Buscar', atajos: ['Ctrl+H'], soloEditor: true, ejecutar: () => void abrirBusquedaEnArchivo() },
  {
    id: 'buscar.proyecto',
    titulo: 'Buscar en el proyecto',
    categoria: 'Buscar',
    atajos: ['Ctrl+Shift+F'],
    ejecutar: () => {
      app().setBusqueda({ conReemplazo: false });
      app().mostrarPanel('buscar');
    },
  },
  {
    id: 'buscar.reemplazarProyecto',
    titulo: 'Reemplazar en el proyecto',
    categoria: 'Buscar',
    atajos: ['Ctrl+Shift+H'],
    ejecutar: () => {
      app().setBusqueda({ conReemplazo: true });
      app().mostrarPanel('buscar');
    },
  },

  { id: 'figuras.cocinar', titulo: 'Cocinar las figuras', categoria: 'Figuras', atajos: [], ejecutar: () => void app().cocinarFiguras() },
  { id: 'figuras.limpiar', titulo: 'Limpiar el cache de figuras', categoria: 'Figuras', atajos: [], ejecutar: () => void app().limpiarFiguras() },
  { id: 'panel.figuras', titulo: 'Mostrar las figuras', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanel('figuras') },
  { id: 'panel.archivos', titulo: 'Mostrar los archivos', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanel('archivos') },
  { id: 'panel.partes', titulo: 'Mostrar las partes', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanel('partes') },
  { id: 'panel.esquema', titulo: 'Mostrar el esquema', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanel('esquema') },
  { id: 'panel.problemas', titulo: 'Mostrar los problemas', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanelInferior('problemas') },
  { id: 'panel.log', titulo: 'Mostrar el log del build', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanelInferior('log') },
  { id: 'panel.historial', titulo: 'Mostrar el historial de trabajos (por qué tardó cada build)', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanelInferior('historial') },
  { id: 'panel.doctor', titulo: 'Mostrar el doctor', categoria: 'Paneles', atajos: [], ejecutar: () => app().mostrarPanelInferior('doctor') },
  { id: 'doctor.correr', titulo: 'Correr el doctor: revisar TeX y el proyecto', categoria: 'Compilación', atajos: [], ejecutar: () => void app().correrDoctor() },
  { id: 'procesos.huerfanos', titulo: 'Buscar procesos de TeX que quedaron de antes', categoria: 'Compilación', atajos: [], ejecutar: () => void app().revisarHuerfanos() },

  formato('negrita', 'Negrita', ['Ctrl+B'], 'negrita'),
  formato('cursiva', 'Cursiva', ['Ctrl+I'], 'cursiva'),
  formato('enfasis', 'Énfasis', ['Ctrl+E'], 'enfasis'),
  formato('subrayado', 'Subrayado', ['Ctrl+U'], 'subrayado'),
  formato('mono', 'Monoespaciado', ['Ctrl+Shift+T'], 'mono'),
  formato('matematicaEnLinea', 'Matemática en línea $…$', ['Ctrl+M'], 'matematica-en-linea'),
  formato('matematicaDisplay', 'Matemática en bloque \\[ … \\]', ['Ctrl+Shift+M'], 'matematica-display'),
  formato('entorno', 'Envolver en un entorno', ['Ctrl+Shift+E'], 'entorno'),
  formato('comentar', 'Comentar o descomentar', ['Ctrl+/'], 'comentar'),
];

/** Los atajos por defecto en la forma que pide `resolverAtajos`. */
export const ATAJOS_POR_DEFECTO: AtajosPorId = Object.fromEntries(COMANDOS.map((c) => [c.id, c.atajos]));

let resueltos: AtajosResueltos = resolverAtajos(ATAJOS_POR_DEFECTO, null);

/** Los atajos vigentes de un comando, ya con el formato para mostrar ("Ctrl+Mayús+P"). */
export function atajosDe(id: string): string[] {
  return (resueltos.porId.get(id) ?? []).map(formatoAtajo);
}

export const avisosDeAtajos = (): string[] => resueltos.avisos;

/** Aplica un `keybindings.json` ya leído (o `null`) y devuelve los avisos que dejó. */
export function aplicarKeybindings(usuario: unknown): string[] {
  resueltos = resolverAtajos(ATAJOS_POR_DEFECTO, usuario);
  return resueltos.avisos;
}

/** Lee el `keybindings.json` de la config del usuario; un archivo roto se avisa y se ignora, no impide arrancar. */
export async function cargarKeybindings(): Promise<void> {
  let texto: string | null = null;
  try {
    texto = await getBackend().readUserConfig('keybindings.json');
  } catch {
    return;
  }
  if (texto === null || texto.trim() === '') return;
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch (e) {
    app().avisar(`keybindings.json no es un JSON válido: ${e instanceof Error ? e.message : e}. Se usan los atajos por defecto.`, 'error');
    return;
  }
  const avisos = aplicarKeybindings(json);
  if (avisos.length) {
    const limpios = avisos.map((a) => a.replace(/^keybindings\.json: /, ''));
    app().avisar(`keybindings.json: ${limpios.slice(0, 3).join('; ')}${limpios.length > 3 ? ` (y ${limpios.length - 3} más)` : ''}`, 'error');
  }
}

export const comandoPorId = (id: string): Comando | undefined => COMANDOS.find((c) => c.id === id);

/** Ctrl+Shift+P: todos los comandos, con su atajo al costado. */
export function abrirPaleta(): void {
  app().abrirQuick({
    titulo: 'Paleta de comandos',
    placeholder: 'Escribí un comando…',
    items: COMANDOS.filter((c) => c.id !== 'nav.paleta').map((c) => ({
      id: c.id,
      titulo: `${c.categoria}: ${c.titulo}`,
      detalle: atajosDe(c.id).join('  '),
      ejecutar: () => c.ejecutar(),
    })),
  });
}

const enCampoAjeno = (e: KeyboardEvent): boolean => {
  const t = e.target;
  return t instanceof HTMLElement && !!t.closest('input, textarea, select') && !t.closest('.cm-editor');
};

/** El oyente de teclado de la ventana (fase de captura). */
export function manejarTecla(e: KeyboardEvent): void {
  const quickAbierto = app().quick !== null;
  const id = quickAbierto ? undefined : buscarPorEvento(resueltos, e);
  const c = id ? comandoPorId(id) : undefined;
  if (c && !(c.soloEditor && enCampoAjeno(e))) {
    e.preventDefault();
    e.stopPropagation();
    void c.ejecutar();
    return;
  }
  // Lo que el navegador haría por su cuenta se frena siempre, pero se deja pasar al editor o al campo de texto que tenga el foco.
  if (esNativoPeligroso(e)) e.preventDefault();
}
