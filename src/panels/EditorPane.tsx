// Pestañas y editor. Hay UNA sola `EditorView`; cada pestaña es un `EditorState` guardado en `editor/docs.ts` y al
// cambiar de pestaña se le pasa el estado de esa (con `setState`, que pierde el scroll: se guarda y se restaura aparte).
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { getDoc, registrarVista } from '../editor/docs';
import { useApp } from '../store/app';

const EOL_NOMBRE = { lf: 'LF', crlf: 'CRLF', cr: 'CR' } as const;

function Pestanas() {
  const tabs = useApp((s) => s.tabs);
  const activeRel = useApp((s) => s.activeRel);
  const rootFile = useApp((s) => s.rootFile);
  const activar = useApp((s) => s.activar);
  const cerrar = useApp((s) => s.cerrarTab);
  const elegirRaiz = useApp((s) => s.elegirRaiz);
  const avisar = useApp((s) => s.avisar);
  const activa = tabs.find((t) => t.rel === activeRel);

  return (
    <div className="pestanas">
      <div className="pestanas-lista">
        {tabs.map((t) => (
          <div key={t.rel} className={`pestana${t.rel === activeRel ? ' activa' : ''}`} onClick={() => activar(t.rel)} title={t.rel}>
            <span className="nombre">{t.name}</span>
            {t.readOnly && <span className="candado" title="Sólo lectura">🔒</span>}
            {t.dirty ? <span className="punto" title="Sin guardar">●</span> : null}
            <button
              className="cerrar"
              onClick={(e) => {
                e.stopPropagation();
                void cerrar(t.rel);
              }}
              title="Cerrar"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {activa && activa.rel.toLowerCase().endsWith('.tex') && activa.rel !== rootFile && (
        <button
          className="boton chico"
          onClick={() => elegirRaiz(activa.rel).catch((e) => avisar(String(e), 'error'))}
          title="Compilar este archivo como raíz del documento"
        >
          Usar como raíz
        </button>
      )}
    </div>
  );
}

function AvisoMezclado() {
  const activeRel = useApp((s) => s.activeRel);
  const tab = useApp((s) => s.tabs.find((t) => t.rel === s.activeRel));
  const hacerEditable = useApp((s) => s.hacerEditable);
  if (!activeRel || !tab?.mixed || !tab.readOnly) return null;
  return (
    <div className="banner">
      <span>
        Este archivo mezcla tipos de salto de línea. Se abrió en sólo lectura para no alterar líneas que no tocaste; si lo editás,
        se guarda con {EOL_NOMBRE[tab.eol]} en todas.
      </span>
      <button className="boton chico" onClick={() => hacerEditable(tab.rel)}>
        Editar y normalizar a {EOL_NOMBRE[tab.eol]}
      </button>
    </div>
  );
}

function Editor() {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const anterior = useRef<string | null>(null);
  const activeRel = useApp((s) => s.activeRel);
  const epoch = useApp((s) => s.tabs.find((t) => t.rel === s.activeRel)?.epoch ?? 0);

  useEffect(() => {
    const view = new EditorView({ parent: ref.current! });
    viewRef.current = view;
    return () => {
      registrarVista(null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Al salir de una pestaña se guarda dónde estaba el scroll.
    if (anterior.current && anterior.current !== activeRel) {
      const previo = getDoc(anterior.current);
      if (previo) previo.scroll = view.scrollSnapshot();
    }
    anterior.current = activeRel;
    const doc = activeRel ? getDoc(activeRel) : undefined;
    if (!doc) {
      registrarVista(null);
      view.setState(EditorState.create({ doc: '', extensions: [EditorView.editable.of(false)] }));
      return;
    }
    view.setState(doc.state);
    registrarVista({ rel: doc.rel, view });
    if (doc.scroll) view.dispatch({ effects: doc.scroll });
    view.focus();
  }, [activeRel, epoch]);

  return <div className={`editor${activeRel ? '' : ' oculto'}`} ref={ref} />;
}

export function EditorPane() {
  const hayPestanas = useApp((s) => s.tabs.length > 0);
  return (
    <div className="editor-panel">
      <Pestanas />
      <AvisoMezclado />
      <Editor />
      {!hayPestanas && <div className="vacio">Abrí un archivo del árbol para editarlo.</div>}
    </div>
  );
}
