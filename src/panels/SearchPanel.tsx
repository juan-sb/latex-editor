// Panel Buscar (10.1 del plan): búsqueda y reemplazo en todo el proyecto. El resultado sale agrupado por archivo; con el campo
// de reemplazo a la vista cada coincidencia muestra lo que quedaría, y nada se escribe hasta confirmar.
import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';

/** La línea con la coincidencia resaltada (y, en la vista previa, lo que quedaría). */
function Linea({ m }: { m: { text: string; offset: number; col: number; len: number; replaced: string | null } }) {
  const ini = Math.max(0, m.col - m.offset);
  const antes = m.text.slice(0, ini);
  const justo = m.text.slice(ini, ini + m.len);
  const despues = m.text.slice(ini + m.len);
  return (
    <span className="buscar-texto">
      {m.offset > 0 && '…'}
      {antes}
      <mark className={m.replaced !== null ? 'viejo' : ''}>{justo}</mark>
      {m.replaced !== null && <mark className="nuevo">{m.replaced}</mark>}
      {despues}
    </span>
  );
}

export function SearchPanel() {
  const b = useApp((s) => s.busqueda);
  const set = useApp((s) => s.setBusqueda);
  const buscar = useApp((s) => s.ejecutarBusqueda);
  const reemplazar = useApp((s) => s.reemplazarTodo);
  const ir = useApp((s) => s.irAUbicacion);
  const hayProyecto = useApp((s) => !!s.project);
  const entrada = useRef<HTMLInputElement>(null);
  const foco = useApp((s) => s.panelIzq);

  // Al mostrar el panel el cursor queda en la caja (es lo que se espera de Ctrl+Mayús+F).
  useEffect(() => {
    if (foco === 'buscar') entrada.current?.focus();
  }, [foco, b.conReemplazo]);

  // Se busca solo 250 ms después de dejar de escribir (o al cambiar una opción).
  useEffect(() => {
    if (!hayProyecto) return;
    const t = setTimeout(() => void buscar(), 250);
    return () => clearTimeout(t);
  }, [b.query, b.regex, b.caseSensitive, b.wholeWord, b.allFiles, b.conReemplazo, b.reemplazo, hayProyecto, buscar]);

  if (!hayProyecto) return <div className="vacio">Abrí una carpeta para empezar.</div>;
  const r = b.resultado;

  return (
    <div className="buscar">
      <div className="buscar-cabecera">
        <div className="buscar-fila">
          <input
            ref={entrada}
            className="buscar-entrada"
            placeholder="Buscar en el proyecto"
            value={b.query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void buscar()}
            spellCheck={false}
          />
          <button className={`icono-boton${b.caseSensitive ? ' on' : ''}`} onClick={() => set({ caseSensitive: !b.caseSensitive })} title="Distinguir mayúsculas">Aa</button>
          <button className={`icono-boton${b.wholeWord ? ' on' : ''}`} onClick={() => set({ wholeWord: !b.wholeWord })} title="Palabra completa">ab</button>
          <button className={`icono-boton${b.regex ? ' on' : ''}`} onClick={() => set({ regex: !b.regex })} title="Expresión regular">.*</button>
        </div>
        {b.conReemplazo && (
          <div className="buscar-fila">
            <input
              className="buscar-entrada"
              placeholder="Reemplazar por"
              value={b.reemplazo}
              onChange={(e) => set({ reemplazo: e.target.value })}
              spellCheck={false}
            />
            <button className="boton chico" disabled={!r || r.total === 0} onClick={() => void reemplazar()} title="Reemplazar todas las coincidencias que se ven">
              Todo
            </button>
          </div>
        )}
        <div className="buscar-fila opciones">
          <label className="filtro">
            <input type="checkbox" checked={b.allFiles} onChange={(e) => set({ allFiles: e.target.checked })} /> todo el árbol
          </label>
          <label className="filtro">
            <input type="checkbox" checked={b.conReemplazo} onChange={(e) => set({ conReemplazo: e.target.checked })} /> reemplazar
          </label>
        </div>
      </div>
      <div className="buscar-resultados">
        {b.error && <div className="buscar-error">{b.error}</div>}
        {r && r.files.length === 0 && !b.error && <div className="vacio">Sin coincidencias.</div>}
        {r?.files.map((f) => (
          <div key={f.file} className="buscar-archivo">
            <div className="buscar-archivo-cab">
              <span className="nombre" title={f.file}>{f.file}</span>
              <span className="contador">{f.matches.length}</span>
              {b.conReemplazo && (
                <button className="icono-boton" onClick={() => void reemplazar([f.file])} title="Reemplazar sólo en este archivo">↻</button>
              )}
            </div>
            {f.matches.map((m, i) => (
              <div key={`${m.line}:${m.col}:${i}`} className="buscar-coincidencia" onClick={() => void ir(f.file, m.line, { inicio: m.col, fin: m.col + m.len })}>
                <span className="linea">{m.line}</span>
                <Linea m={m} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="partes-pie">
        {b.buscando ? 'Buscando…' : r ? `${r.total} coincidencia${r.total === 1 ? '' : 's'} en ${r.files.length} archivo${r.files.length === 1 ? '' : 's'}${r.truncated ? ' (se muestran las primeras)' : ''} · ${r.files_scanned} leídos · ${r.ms} ms` : 'Escribí para buscar'}
      </div>
    </div>
  );
}
