// Diálogo modal y aviso. El diálogo es propio y no `window.confirm`: los diálogos de script del WebView no son confiables
// dentro de Tauri, y además el store necesita preguntas con más de dos botones.
import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';

export function Dialogo() {
  const dialog = useApp((s) => s.dialog);
  const responder = useApp((s) => s.responderDialogo);
  const primero = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!dialog) return;
    primero.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dialog.botones.some((b) => b.id === 'cancelar')) {
        e.preventDefault();
        responder('cancelar');
      }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [dialog, responder]);

  if (!dialog) return null;
  const hayPrimario = dialog.botones.some((b) => b.primary);
  return (
    <div className="velo">
      <div className="dialogo" role="dialog" aria-modal="true">
        <p className="mensaje">{dialog.mensaje}</p>
        {dialog.detalle && <p className="detalle">{dialog.detalle}</p>}
        <div className="botones">
          {dialog.botones.map((b, i) => (
            <button
              key={b.id}
              ref={b.primary || (!hayPrimario && i === 0) ? primero : undefined}
              className={`boton${b.primary ? ' primario' : ''}`}
              onClick={() => responder(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Aviso() {
  const notice = useApp((s) => s.notice);
  const cerrar = useApp((s) => s.cerrarAviso);
  useEffect(() => {
    if (!notice || notice.nivel === 'error') return;
    const t = setTimeout(cerrar, 9000);
    return () => clearTimeout(t);
  }, [notice, cerrar]);
  if (!notice) return null;
  return (
    <div className={`aviso ${notice.nivel}`} role="status">
      <span>{notice.texto}</span>
      <button className="icono-boton" onClick={cerrar} title="Cerrar">×</button>
    </div>
  );
}
