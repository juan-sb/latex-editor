// Pestaña de una imagen o un PDF del proyecto (los que se eligen en el árbol): se muestran en un visor en lugar del editor de texto,
// que daba error al intentar leerlos como UTF-8. Los bytes llegan por `readPdf`, que lee cualquier archivo del proyecto sin dejar
// un handle abierto. El visor del PDF es otro `PdfViewerHost`, independiente del panel del documento (no participa de SyncTeX).
import { useEffect, useRef, useState } from 'react';
import { getBackend } from '../backend';
import { PdfViewerHost, type PdfEstado } from '../pdf/viewer';
import { useApp, type TabMeta } from '../store/app';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

function VisorImagen({ tab }: { tab: TabMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [real, setReal] = useState(false);
  const [tam, setTam] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let vigente = true;
    let creada: string | null = null;
    setError(null);
    (async () => {
      try {
        const bytes = await getBackend().readPdf(tab.rel);
        if (!vigente) return;
        const ext = tab.rel.split('.').pop()?.toLowerCase() ?? '';
        creada = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }));
        setUrl(creada);
      } catch (e) {
        if (vigente) setError(mensajeDe(e));
      }
    })();
    return () => {
      vigente = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [tab.rel, tab.epoch]);

  return (
    <div className="visor-archivo">
      <div className="visor-barra">
        <span className="visor-ruta">{tab.rel}</span>
        {tam && (
          <span className="visor-dato">
            {tam.w} × {tam.h} px
          </span>
        )}
        <button className={`boton chico${real ? ' activo' : ''}`} onClick={() => setReal(!real)} title="Ver a tamaño real o ajustada al panel">
          {real ? '100 %' : 'Ajustada'}
        </button>
      </div>
      <div className={`visor-imagen${real ? ' real' : ''}`}>
        {error ? (
          <div className="vacio">No se pudo mostrar la imagen: {error}</div>
        ) : (
          url && <img src={url} alt={tab.name} onLoad={(e) => setTam({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setError('el formato no se puede mostrar')} />
        )}
      </div>
    </div>
  );
}

function VisorPdf({ tab }: { tab: TabMeta }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<PdfViewerHost | null>(null);
  const [estado, setEstado] = useState<PdfEstado>({ pagina: 0, paginas: 0, escala: 1, modo: 'ancho' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = new PdfViewerHost(areaRef.current!);
    hostRef.current = host;
    const baja = host.suscribir(setEstado);
    // Ctrl + rueda hace zoom, como en el panel del PDF (el listener no puede ser pasivo).
    const rueda = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) host.zoomMas();
      else host.zoomMenos();
    };
    const area = areaRef.current!;
    area.addEventListener('wheel', rueda, { passive: false });
    return () => {
      area.removeEventListener('wheel', rueda);
      baja();
      hostRef.current = null;
      void host.destruir();
    };
  }, [tab.rel]);

  useEffect(() => {
    let vigente = true;
    setError(null);
    (async () => {
      try {
        const bytes = await getBackend().readPdf(tab.rel);
        if (vigente) await hostRef.current?.cargar(bytes, `${tab.rel}#${tab.epoch}`);
      } catch (e) {
        if (vigente) setError(mensajeDe(e));
      }
    })();
    return () => {
      vigente = false;
    };
  }, [tab.rel, tab.epoch]);

  const h = hostRef.current;
  const hay = estado.paginas > 0;
  return (
    <div className="visor-archivo">
      <div className="visor-barra">
        <span className="visor-ruta">{tab.rel}</span>
        <button className="icono-boton" disabled={!hay} onClick={() => h?.anterior()} title="Página anterior">◀</button>
        <span className="visor-dato">
          {estado.pagina || '–'} / {estado.paginas || '–'}
        </span>
        <button className="icono-boton" disabled={!hay} onClick={() => h?.siguiente()} title="Página siguiente">▶</button>
        <button className="icono-boton" disabled={!hay} onClick={() => h?.zoomMenos()} title="Alejar">−</button>
        <span className="visor-dato">{Math.round(estado.escala * 100)} %</span>
        <button className="icono-boton" disabled={!hay} onClick={() => h?.zoomMas()} title="Acercar">+</button>
        <button className={`boton chico${estado.modo === 'ancho' ? ' activo' : ''}`} disabled={!hay} onClick={() => h?.ajustarAncho()} title="Ajustar al ancho">
          Ancho
        </button>
      </div>
      <div className="pdf-area visor-pdf" ref={areaRef} tabIndex={0}>
        {error && <div className="vacio">No se pudo mostrar el PDF: {error}</div>}
      </div>
    </div>
  );
}

/** El visor de la pestaña activa, si es una imagen o un PDF. */
export function VisorArchivo() {
  const tab = useApp((s) => s.tabs.find((t) => t.rel === s.activeRel && t.visor));
  if (!tab) return null;
  // `key`: cambiar de una imagen a otra (o a un PDF) arma un visor nuevo, sin arrastrar el estado del anterior.
  return tab.visor === 'pdf' ? <VisorPdf key={tab.rel} tab={tab} /> : <VisorImagen key={tab.rel} tab={tab} />;
}
