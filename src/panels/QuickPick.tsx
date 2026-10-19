// Selector rápido: una caja de texto y una lista filtrada con el filtro difuso. Lo usan abrir archivo (Ctrl+P), la paleta de
// comandos (Ctrl+Shift+P), ir a sección o etiqueta (Ctrl+Shift+O y Ctrl+T) y "dónde se usa" (Shift+F12).
import { useEffect, useMemo, useRef, useState } from 'react';
import { filtrarDifuso } from '../comandos/difuso';
import { useApp, type QuickItem } from '../store/app';

export function QuickPick() {
  const quick = useApp((s) => s.quick);
  const cerrar = useApp((s) => s.cerrarQuick);
  const [consulta, setConsulta] = useState('');
  const [sel, setSel] = useState(0);
  const lista = useRef<HTMLDivElement>(null);

  // Cada vez que se abre uno (otro título o otros items) se vuelve a empezar de cero.
  useEffect(() => {
    setConsulta('');
    setSel(0);
  }, [quick]);

  const visibles = useMemo(
    () => (quick ? filtrarDifuso(quick.items, consulta, (i) => `${i.titulo} ${i.detalle ?? ''}`) : []),
    [quick, consulta],
  );

  useEffect(() => {
    lista.current?.querySelector('.quick-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel, visibles]);

  if (!quick) return null;

  const elegir = (item: QuickItem | undefined) => {
    if (!item) return;
    // Se cierra antes de ejecutar: el comando puede abrir otro selector (la paleta lo hace) y no tiene que perderlo.
    cerrar();
    void item.ejecutar();
  };

  const tecla = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cerrar();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, visibles.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      elegir(visibles[sel]);
    }
  };

  return (
    <div className="velo quick-velo" onMouseDown={(e) => e.target === e.currentTarget && cerrar()}>
      <div className="quick" role="dialog" aria-label={quick.titulo}>
        <input
          autoFocus
          className="quick-entrada"
          placeholder={quick.placeholder}
          value={consulta}
          onChange={(e) => {
            setConsulta(e.target.value);
            setSel(0);
          }}
          onKeyDown={tecla}
          spellCheck={false}
        />
        <div className="quick-lista" ref={lista}>
          {visibles.length === 0 && <div className="quick-vacio">Sin coincidencias</div>}
          {visibles.map((item, i) => (
            <div key={item.id} className={`quick-item${i === sel ? ' sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => elegir(item)}>
              <span className="titulo">{item.titulo}</span>
              {item.detalle && <span className="detalle">{item.detalle}</span>}
            </div>
          ))}
        </div>
        <div className="quick-pie">
          {quick.titulo} · {visibles.length} de {quick.items.length}
        </div>
      </div>
    </div>
  );
}
