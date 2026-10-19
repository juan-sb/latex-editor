// Panel inferior con pestañas: Problemas, Log, Historial y Doctor (10.1 del plan).
import { useApp } from '../store/app';
import { DoctorPanel } from './DoctorPanel';
import { HistorialPanel } from './HistorialPanel';
import { LogPanel } from './LogPanel';
import { ProblemsPanel } from './ProblemsPanel';

export function BottomPanel() {
  const panel = useApp((s) => s.panelInferior);
  const mostrar = useApp((s) => s.mostrarPanelInferior);
  const errores = useApp((s) => s.problems.filter((p) => p.severity === 'error').length);
  const avisos = useApp((s) => s.problems.filter((p) => p.severity === 'warning').length);
  const doctorErrores = useApp((s) => s.doctor?.hallazgos.filter((h) => h.nivel === 'error').length ?? 0);
  const doctorAvisos = useApp((s) => s.doctor?.hallazgos.filter((h) => h.nivel === 'aviso').length ?? 0);
  return (
    <div className="inferior">
      <div className="inferior-pestanas" role="tablist">
        <button role="tab" aria-selected={panel === 'problemas'} className={panel === 'problemas' ? 'activa' : ''} onClick={() => mostrar('problemas')}>
          Problemas
          {errores + avisos > 0 && (
            <span className={`contador ${errores > 0 ? 'error' : 'warning'}`}>{errores + avisos}</span>
          )}
        </button>
        <button role="tab" aria-selected={panel === 'log'} className={panel === 'log' ? 'activa' : ''} onClick={() => mostrar('log')}>
          Log
        </button>
        <button role="tab" aria-selected={panel === 'historial'} className={panel === 'historial' ? 'activa' : ''} onClick={() => mostrar('historial')}>
          Historial
        </button>
        <button role="tab" aria-selected={panel === 'doctor'} className={panel === 'doctor' ? 'activa' : ''} onClick={() => mostrar('doctor')}>
          Doctor
          {doctorErrores + doctorAvisos > 0 && (
            <span className={`contador ${doctorErrores > 0 ? 'error' : 'warning'}`}>{doctorErrores + doctorAvisos}</span>
          )}
        </button>
      </div>
      <div className="inferior-cuerpo">
        {panel === 'log' && <LogPanel />}
        {panel === 'problemas' && <ProblemsPanel />}
        {panel === 'historial' && <HistorialPanel />}
        {panel === 'doctor' && <DoctorPanel />}
      </div>
    </div>
  );
}
