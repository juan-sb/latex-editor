// Panel del PDF: barra de zoom y navegación y el visor. El visor lo maneja `PdfViewerHost` (imperativo); acá sólo se lo
// crea, se le pasan los bytes cuando el store avisa que hay un PDF nuevo y se refleja su estado en la barra.
import { useEffect, useRef, useState } from 'react';
import { getBackend } from '../backend';
import { useApp } from '../store/app';
import { pdfActual, PdfViewerHost, type PdfEstado } from './viewer';

const VACIO: PdfEstado = { pagina: 0, paginas: 0, escala: 1, modo: 'ancho' };

export function PdfPane() {
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<PdfViewerHost | null>(null);
  const [estado, setEstado] = useState<PdfEstado>(VACIO);
  const [cargando, setCargando] = useState(false);
  const [paginaTexto, setPaginaTexto] = useState('');
  const pdfRel = useApp((s) => s.pdfRel);
  const pdfEpoch = useApp((s) => s.pdfEpoch);
  const status = useApp((s) => s.build.status);
  const stale = useApp((s) => s.pdfStale);
  const avisar = useApp((s) => s.avisar);

  useEffect(() => {
    const host = new PdfViewerHost(areaRef.current!);
    hostRef.current = host;
    pdfActual.host = host;
    const baja = host.suscribir((e) => setEstado(e));
    return () => {
      baja();
      pdfActual.host = null;
      hostRef.current = null;
      void host.destruir();
    };
  }, []);

  // Cada vez que el store sube `pdfEpoch` hay un PDF nuevo para mostrar.
  useEffect(() => {
    if (!pdfRel || pdfEpoch === 0) return;
    let vigente = true;
    setCargando(true);
    (async () => {
      try {
        const bytes = await getBackend().readPdf(pdfRel);
        if (vigente) await hostRef.current?.cargar(bytes, `${pdfRel}#${pdfEpoch}`);
      } catch (e) {
        avisar(`No se pudo mostrar el PDF: ${e instanceof Error ? e.message : e}`, 'error');
      } finally {
        if (vigente) setCargando(false);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [pdfRel, pdfEpoch, avisar]);

  useEffect(() => setPaginaTexto(estado.pagina ? String(estado.pagina) : ''), [estado.pagina]);

  // Ctrl + rueda hace zoom (el listener no puede ser pasivo: tiene que impedir el zoom de la página entera).
  useEffect(() => {
    const el = areaRef.current!;
    const rueda = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) hostRef.current?.zoomMas();
      else hostRef.current?.zoomMenos();
    };
    el.addEventListener('wheel', rueda, { passive: false });
    return () => el.removeEventListener('wheel', rueda);
  }, []);

  const teclas = (e: React.KeyboardEvent) => {
    const h = hostRef.current;
    if (!h) return;
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) h.zoomMas();
    else if (e.ctrlKey && e.key === '-') h.zoomMenos();
    else if (e.ctrlKey && e.key === '0') h.setEscala(1);
    else if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'w') h.ajustarAncho();
    else return;
    e.preventDefault();
  };

  const h = hostRef.current;
  const hayPdf = estado.paginas > 0;
  return (
    <div className="pdf-panel">
      <div className="pdf-barra">
        <button className="icono-boton" disabled={!hayPdf} onClick={() => h?.anterior()} title="Página anterior">◀</button>
        <input
          className="pagina"
          value={paginaTexto}
          disabled={!hayPdf}
          onChange={(e) => setPaginaTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') h?.irA(Number(paginaTexto) || 1);
            e.stopPropagation();
          }}
          title="Ir a la página"
        />
        <span className="de">/ {estado.paginas || '–'}</span>
        <button className="icono-boton" disabled={!hayPdf} onClick={() => h?.siguiente()} title="Página siguiente">▶</button>
        <span className="sep" />
        <button className="icono-boton" disabled={!hayPdf} onClick={() => h?.zoomMenos()} title="Alejar (Ctrl+-)">−</button>
        <span className="zoom">{Math.round(estado.escala * 100)} %</span>
        <button className="icono-boton" disabled={!hayPdf} onClick={() => h?.zoomMas()} title="Acercar (Ctrl+=)">+</button>
        <button className={`boton chico${estado.modo === 'ancho' ? ' activo' : ''}`} disabled={!hayPdf} onClick={() => h?.ajustarAncho()} title="Ajustar al ancho de la página (W)">
          Ancho
        </button>
        {cargando && <span className="cargando">Cargando…</span>}
      </div>
      <div className={`pdf-area${stale ? ' desactualizado' : ''}`} ref={areaRef} tabIndex={0} onKeyDown={teclas}>
        {/* Los contenedores de cada visor los arma `PdfViewerHost` adentro de este elemento. */}
        {!hayPdf && !cargando && (
          <div className="vacio">{status === 'running' ? 'Compilando…' : 'Todavía no hay PDF. Compilá con Ctrl+Enter.'}</div>
        )}
      </div>
      {stale && hayPdf && <div className="pdf-aviso">El último build no terminó bien: este es el último PDF bueno.</div>}
    </div>
  );
}
