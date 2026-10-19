import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cargarKeybindings, manejarTecla } from './comandos/comandos';
import { PdfPane } from './pdf/PdfPane';
import { EditorPane } from './panels/EditorPane';
import { Sidebar } from './panels/Sidebar';
import { BottomPanel } from './panels/BottomPanel';
import { Aviso, Dialogo } from './panels/Overlays';
import { QuickPick } from './panels/QuickPick';
import { TopBar } from './panels/TopBar';
import { useApp } from './store/app';

/**
 * Atajos de ventana. Se atienden en la fase de captura y se frenan ahí: sin eso WebView2 abre "Guardar como" con Ctrl+S,
 * recarga la página con F5 y Ctrl+R (se perdería lo que no se guardó) e imprime con Ctrl+P, y CodeMirror se quedaría
 * con Ctrl+Enter (inserta una línea) y Ctrl+M (deja de capturar el Tab). Qué atajo es de qué comando lo decide
 * `comandos/comandos.ts`, con el `keybindings.json` del usuario encima de los de fábrica.
 */
function useAtajosGlobales() {
  useEffect(() => {
    window.addEventListener('keydown', manejarTecla, true);
    return () => window.removeEventListener('keydown', manejarTecla, true);
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
      .then(async (opts) => {
        // Los atajos del usuario tienen que estar antes de que el smoke (o la persona) empiece a teclear.
        await cargarKeybindings();
        // El smoke de aceptación sólo se carga cuando se pide: no entra en el uso normal.
        if (opts.smoke && !smokeIniciado) {
          smokeIniciado = true;
          void (opts.smokeMode === 'f6'
            ? import('./smoke-f6').then((m) => m.correrSmokeF6(opts))
            : opts.smokeMode === 'f5'
              ? import('./smoke-f5').then((m) => m.correrSmokeF5(opts))
              : opts.smokeMode === 'f4'
              ? import('./smoke-f4').then((m) => m.correrSmokeF4(opts))
              : opts.smokeMode === 'f3'
                ? import('./smoke-f3').then((m) => m.correrSmokeF3(opts))
                : opts.smokeMode === 'f2'
                  ? import('./smoke-f2').then((m) => m.correrSmokeF2(opts))
                  : import('./smoke').then((m) => m.correrSmoke(opts)));
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
          <BottomPanel />
        </Panel>
      </PanelGroup>
      <Aviso />
      <Dialogo />
      <QuickPick />
    </div>
  );
}
