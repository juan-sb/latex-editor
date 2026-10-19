import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { PdfPane } from './pdf/PdfPane';
import { EditorPane } from './panels/EditorPane';
import { Sidebar } from './panels/Sidebar';
import { LogPanel } from './panels/LogPanel';
import { Aviso, Dialogo } from './panels/Overlays';
import { TopBar } from './panels/TopBar';
import { useApp } from './store/app';

/**
 * Atajos de ventana. Se atienden en la fase de captura y se frenan ahí: sin eso WebView2 abre "Guardar como" con Ctrl+S,
 * recarga la página con F5 y Ctrl+R (se perdería lo que no se guardó) e imprime con Ctrl+P, y CodeMirror se quedaría
 * con Ctrl+Enter (inserta una línea). El keymap configurable y la anulación completa son de F5.
 */
function useAtajosGlobales() {
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const store = useApp.getState();
      if (ctrl && !e.altKey && !e.shiftKey && k === 's') {
        e.preventDefault();
        e.stopPropagation();
        void store.guardar();
      } else if (ctrl && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void store.compilar();
      } else if (ctrl && !e.altKey && e.shiftKey && e.key === 'Enter') {
        // Compilar la parte del archivo abierto (la opción 1 del menú de inspo).
        e.preventDefault();
        e.stopPropagation();
        void store.compilarParteActiva();
      } else if (e.key === 'F5' || (ctrl && (k === 'r' || k === 'p'))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, []);
}

/** En desarrollo React ejecuta los efectos dos veces (StrictMode): el smoke tiene que correr una sola. */
let smokeIniciado = false;

export default function App() {
  useAtajosGlobales();
  const init = useApp((s) => s.init);
  const avisar = useApp((s) => s.avisar);

  useEffect(() => {
    init()
      .then((opts) => {
        // El smoke de aceptación sólo se carga cuando se pide: no entra en el uso normal.
        if (opts.smoke && !smokeIniciado) {
          smokeIniciado = true;
          void (opts.smokeMode === 'f2' ? import('./smoke-f2').then((m) => m.correrSmokeF2(opts)) : import('./smoke').then((m) => m.correrSmoke(opts)));
        }
      })
      .catch((e) => avisar(`No se pudo iniciar: ${e instanceof Error ? e.message : e}`, 'error'));
  }, [init, avisar]);

  return (
    <div className="app">
      <TopBar />
      <PanelGroup direction="vertical" autoSaveId="lv-vertical" className="cuerpo">
        <Panel defaultSize={76} minSize={25}>
          <PanelGroup direction="horizontal" autoSaveId="lv-horizontal">
            <Panel defaultSize={17} minSize={8} maxSize={40}>
              <Sidebar />
            </Panel>
            <PanelResizeHandle className="asa" />
            <Panel defaultSize={42} minSize={18}>
              <EditorPane />
            </Panel>
            <PanelResizeHandle className="asa" />
            <Panel defaultSize={41} minSize={14}>
              <PdfPane />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="asa horizontal" />
        <Panel defaultSize={24} minSize={6} collapsible>
          <LogPanel />
        </Panel>
      </PanelGroup>
      <Aviso />
      <Dialogo />
    </div>
  );
}
