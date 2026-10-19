// Panel Historial (9 del plan): una línea por cada trabajo de la cola (build, figuras, exportar, fragmento), con las pistas de por
// qué tardó lo que tardó: figuras cocinadas por pgf, `.fdb_latexmk` borrados porque cambió un dato, `.aux` reparado, un archivo
// cambiado afuera que lo disparó...
import { useState } from 'react';
import { useApp } from '../store/app';
import { duracion, hora, motivoCorto, NOMBRE_DE_TIPO, resultado, resumen } from '../store/historial';

const ICONO = { ok: '✓', fail: '●', cancelled: '■' } as const;

export function HistorialPanel() {
  const lista = useApp((s) => s.historialTrabajos);
  const [abierta, setAbierta] = useState<number | null>(null);
  return (
    <div className="historial" role="list">
      {lista.length === 0 && <div className="vacio">Todavía no corrió ningún trabajo en este proyecto.</div>}
      {lista.map((e, i) => {
        const r = resultado(e);
        return (
          <div key={`${e.inicioMs}:${e.tipo}:${i}`} role="listitem" className={`hist-fila ${r}`}>
            <div className="hist-linea" onClick={() => setAbierta(abierta === i ? null : i)} title="Clic para ver el detalle">
              <span className="hist-icono">{ICONO[r]}</span>
              <span className="hist-hora">{hora(e.inicioMs)}</span>
              <span className="hist-tipo">{NOMBRE_DE_TIPO[e.tipo]}</span>
              <span className="hist-perfil">{e.perfil ?? ''}</span>
              <span className="hist-ms">{duracion(e.ms)}</span>
              <span className="hist-resumen">{resumen(e)}</span>
              <span className="hist-motivo">{motivoCorto(e.motivo)}</span>
            </div>
            {e.pistas.length > 0 && (
              <ul className="hist-pistas">
                {e.pistas.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            )}
            {abierta === i && (
              <div className="hist-detalle">
                {(e.herramientas ?? []).length > 0 && <div>Herramientas: {(e.herramientas ?? []).map((h) => `${h.nombre} ${duracion(h.ms)}`).join(' · ')}</div>}
                {(e.partes ?? []).length > 0 && (
                  <div>
                    Partes: {(e.partes ?? []).map((p) => `${p.num ? `${p.num} ` : ''}${p.parte} ${duracion(p.ms)}${p.ok ? '' : ' (falló)'}`).join(' · ')}
                  </div>
                )}
                {(e.figurasEnElBuild ?? []).length > 0 && <div>Figuras cocinadas en el build: {(e.figurasEnElBuild ?? []).join(', ')}</div>}
                {(e.datosCambiados ?? []).length > 0 && <div>Datos que cambiaron: {(e.datosCambiados ?? []).join(', ')}</div>}
                {e.destino && <div>Destino: {e.destino}</div>}
                <div>Motivo: {e.motivo}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
