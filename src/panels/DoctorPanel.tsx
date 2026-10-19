// Panel Doctor (9 del plan): qué falta o qué está mal en la máquina o en el proyecto, con cómo se arregla. Sólo mira: no cambia nada.
import { useApp } from '../store/app';
import { contarHallazgos, ICONO_DE_NIVEL, ordenarHallazgos } from '../store/historial';

export function DoctorPanel() {
  const informe = useApp((s) => s.doctor);
  const corriendo = useApp((s) => s.doctorCorriendo);
  const correr = useApp((s) => s.correrDoctor);
  const ir = useApp((s) => s.irAUbicacion);
  const n = informe ? contarHallazgos(informe.hallazgos) : null;
  return (
    <div className="doctor">
      <div className="doctor-cabecera">
        <button disabled={corriendo} onClick={() => void correr()}>
          {corriendo ? 'Revisando…' : 'Volver a revisar'}
        </button>
        {informe && n && (
          <span className="detalle">
            {informe.distribucion ? `${informe.distribucion} · ` : ''}
            {n.error} error{n.error === 1 ? '' : 'es'} · {n.aviso} aviso{n.aviso === 1 ? '' : 's'} · {n.info} informativo{n.info === 1 ? '' : 's'} · {n.ok} bien · {informe.ms} ms
          </span>
        )}
      </div>
      <div className="doctor-lista" role="list">
        {!informe && <div className="vacio">{corriendo ? 'Revisando las herramientas y el proyecto…' : 'El doctor todavía no corrió.'}</div>}
        {informe &&
          ordenarHallazgos(informe.hallazgos).map((h, i) => (
            <div key={`${h.id}:${i}`} role="listitem" className={`hallazgo ${h.nivel}`}>
              <span className="icono">{ICONO_DE_NIVEL[h.nivel]}</span>
              <div className="hallazgo-cuerpo">
                <div className="hallazgo-titulo">{h.titulo}</div>
                {h.detalle && <div className="hallazgo-detalle">{h.detalle}</div>}
                {h.arreglo && <div className="hallazgo-arreglo">Cómo se arregla: {h.arreglo}</div>}
              </div>
              {h.archivo && (
                <button className="donde" onClick={() => void ir(h.archivo as string, h.linea ?? 1)} title="Abrir en el editor">
                  {h.archivo.split('/').pop()}
                  {h.linea ? `:${h.linea}` : ''}
                </button>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
