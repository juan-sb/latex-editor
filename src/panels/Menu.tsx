// Menú desplegable mínimo: un botón que abre un panel y se cierra al hacer clic afuera o con Escape.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Menu({ etiqueta, titulo, children, alinear = 'der' }: { etiqueta: ReactNode; titulo?: string; children: ReactNode; alinear?: 'izq' | 'der' }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const afuera = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    window.addEventListener('mousedown', afuera);
    window.addEventListener('keydown', tecla);
    return () => {
      window.removeEventListener('mousedown', afuera);
      window.removeEventListener('keydown', tecla);
    };
  }, [abierto]);

  return (
    <div className="menu" ref={ref}>
      <button className={`boton${abierto ? ' activo' : ''}`} onClick={() => setAbierto((a) => !a)} title={titulo} aria-haspopup="true" aria-expanded={abierto}>
        {etiqueta}
      </button>
      {abierto && (
        <div className={`menu-panel ${alinear}`} role="menu" onClick={(e) => {
          // Un elemento con `data-cierra` cierra el menú al elegirlo; los selectores y casillas lo dejan abierto.
          if ((e.target as HTMLElement).closest('[data-cierra]')) setAbierto(false);
        }}>
          {children}
        </div>
      )}
    </div>
  );
}
