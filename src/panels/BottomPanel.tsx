// Panel inferior con pestañas: Problemas y Log (10.1 del plan: el Historial se suma en F8).
import { useApp } from '../store/app';
import { LogPanel } from './LogPanel';
import { ProblemsPanel } from './ProblemsPanel';

export function BottomPanel() {
  const panel = useApp((s) => s.panelInferior);
  const mostrar = useApp((s) => s.mostrarPanelInferior);
  const errores = useApp((s) => s.problems.filter((p) => p.severity === 'error').length);
  const avisos = useApp((s) => s.problems.filter((p) => p.severity === 'warning').length);
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
      </div>
      <div className="inferior-cuerpo">{panel === 'log' ? <LogPanel /> : <ProblemsPanel />}</div>
    </div>
  );
}
