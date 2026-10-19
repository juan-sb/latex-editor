// Panel izquierdo con pestañas: Archivos, Partes, Esquema, Buscar y Figuras (10.1 del plan).
import { useApp, type PanelIzquierdo } from '../store/app';
import { EsquemaPanel } from './EsquemaPanel';
import { FigurasPanel } from './FigurasPanel';
import { FileTree } from './FileTree';
import { PartsPanel } from './PartsPanel';
import { SearchPanel } from './SearchPanel';

const PESTANAS: { id: PanelIzquierdo; titulo: string }[] = [
  { id: 'archivos', titulo: 'Archivos' },
  { id: 'partes', titulo: 'Partes' },
  { id: 'esquema', titulo: 'Esquema' },
  { id: 'buscar', titulo: 'Buscar' },
  { id: 'figuras', titulo: 'Figuras' },
];

export function Sidebar() {
  const panel = useApp((s) => s.panelIzq);
  const mostrar = useApp((s) => s.mostrarPanel);
  return (
    <div className="sidebar">
      <div className="sidebar-pestanas" role="tablist">
        {PESTANAS.map((p) => (
          <button key={p.id} role="tab" aria-selected={panel === p.id} className={panel === p.id ? 'activa' : ''} onClick={() => mostrar(p.id)}>
            {p.titulo}
          </button>
        ))}
      </div>
      <div className="sidebar-cuerpo">
        {panel === 'archivos' ? (
          <FileTree />
        ) : panel === 'partes' ? (
          <PartsPanel />
        ) : panel === 'esquema' ? (
          <EsquemaPanel />
        ) : panel === 'buscar' ? (
          <SearchPanel />
        ) : (
          <FigurasPanel />
        )}
      </div>
    </div>
  );
}
