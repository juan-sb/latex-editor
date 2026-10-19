// Panel izquierdo con pestañas: Archivos y Partes (10.1 del plan: Esquema, Buscar y Figuras se suman en fases que vienen).
import { useApp } from '../store/app';
import { FileTree } from './FileTree';
import { PartsPanel } from './PartsPanel';

export function Sidebar() {
  const panel = useApp((s) => s.panelIzq);
  const mostrar = useApp((s) => s.mostrarPanel);
  const hayPartes = useApp((s) => (s.project?.parts.length ?? 0) > 0);
  return (
    <div className="sidebar">
      <div className="sidebar-pestanas" role="tablist">
        <button role="tab" aria-selected={panel === 'archivos'} className={panel === 'archivos' ? 'activa' : ''} onClick={() => mostrar('archivos')}>
          Archivos
        </button>
        <button role="tab" aria-selected={panel === 'partes'} className={panel === 'partes' ? 'activa' : ''} onClick={() => mostrar('partes')}>
          Partes{hayPartes ? '' : ' (ninguna)'}
        </button>
      </div>
      <div className="sidebar-cuerpo">{panel === 'archivos' ? <FileTree /> : <PartsPanel />}</div>
    </div>
  );
}
