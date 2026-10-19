// Panel inferior con el log crudo del build. Sólo se renderizan las líneas que se ven (más un margen): el completo
// escribe miles de líneas y un `<pre>` con todo el texto se volvería a armar en cada lote de 50 ms.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { logBuffer } from '../store/logbuffer';

const ALTO_LINEA = 17;
const MARGEN = 12;

export function LogPanel() {
  useSyncExternalStore(logBuffer.subscribe, logBuffer.getVersion);
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [alto, setAlto] = useState(300);
  // Si el usuario está mirando el final, el panel sigue al log; si subió a leer algo, se queda donde está.
  const alFinal = useRef(true);

  const n = logBuffer.length;
  const desde = Math.max(0, Math.floor(scrollTop / ALTO_LINEA) - MARGEN);
  const hasta = Math.min(n, Math.ceil((scrollTop + alto) / ALTO_LINEA) + MARGEN);
  const lineas = logBuffer.slice(desde, hasta);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && alFinal.current) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const el = ref.current!;
    const o = new ResizeObserver(() => setAlto(el.clientHeight));
    o.observe(el);
    setAlto(el.clientHeight);
    return () => o.disconnect();
  }, []);

  return (
    <div className="log-panel">
      <div className="log-cabecera">
        <span className="titulo">Log</span>
        <span className="detalle">
          {n > 1 ? `${n - 1} líneas` : 'vacío'}
          {logBuffer.lineasDescartadas > 0 ? ` (se descartaron ${logBuffer.lineasDescartadas} anteriores)` : ''}
        </span>
        <button className="boton chico" onClick={() => logBuffer.clear()} disabled={n <= 1}>
          Limpiar
        </button>
      </div>
      <div
        className="log-cuerpo"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          alFinal.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
        }}
      >
        <div style={{ height: n * ALTO_LINEA, position: 'relative' }}>
          <pre className="log-lineas" style={{ top: desde * ALTO_LINEA }}>
            {lineas.join('\n')}
          </pre>
        </div>
      </div>
    </div>
  );
}
