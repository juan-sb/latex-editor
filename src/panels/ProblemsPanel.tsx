// Panel de problemas (10.1 del plan): lo que el parser sacó del log del último build, con filtro por severidad y por
// texto. Un clic abre el archivo en la línea; F8 y Mayús+F8 recorren los mismos que muestra la lista.
import { useMemo } from 'react';
import { useApp } from '../store/app';
import { listaDeProblemas, visibles } from '../store/problemas';

const ICONO = { error: '●', warning: '▲', badbox: '○' } as const;

export function ProblemsPanel() {
  const problems = useApp((s) => s.problems);
  const filtro = useApp((s) => s.filtro);
  const actual = useApp((s) => s.problemaIdx);
  const setFiltro = useApp((s) => s.setFiltro);
  const ir = useApp((s) => s.irAProblema);
  const perfil = useApp((s) => s.build.perfil);
  const simbolos = useApp((s) => s.simbolos);
  // Los del build y, después, los del lint (que se calculan sin compilar).
  const todos = useMemo(() => listaDeProblemas(problems, simbolos), [problems, simbolos]);
  const lista = useMemo(() => visibles(todos, filtro), [todos, filtro]);
  const n = useMemo(
    () => ({
      error: problems.filter((p) => p.severity === 'error').length,
      warning: problems.filter((p) => p.severity === 'warning').length,
      badbox: problems.filter((p) => p.severity === 'badbox').length,
      lint: simbolos?.lint.length ?? 0,
    }),
    [problems, simbolos],
  );

  return (
    <div className="problemas">
      <div className="problemas-cabecera">
        <label className="filtro error">
          <input type="checkbox" checked={filtro.errores} onChange={(e) => setFiltro({ errores: e.target.checked })} />● Errores ({n.error})
        </label>
        <label className="filtro warning">
          <input type="checkbox" checked={filtro.avisos} onChange={(e) => setFiltro({ avisos: e.target.checked })} />▲ Avisos ({n.warning})
        </label>
        <label className="filtro badbox" title="Overfull y Underfull">
          <input type="checkbox" checked={filtro.badboxes} onChange={(e) => setFiltro({ badboxes: e.target.checked })} />○ Cajas mal llenas ({n.badbox})
        </label>
        <label className="filtro lint" title="Etiquetas rotas, entornos sin cerrar y otras cosas que se ven sin compilar">
          <input type="checkbox" checked={filtro.lint} onChange={(e) => setFiltro({ lint: e.target.checked })} />◇ Lint ({n.lint})
        </label>
        <input className="buscar" placeholder="Filtrar…" value={filtro.texto} onChange={(e) => setFiltro({ texto: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <span className="detalle">{perfil ? `perfil ${perfil} · ` : ''}F8 siguiente · Mayús+F8 anterior</span>
      </div>
      <div className="problemas-lista" role="list">
        {lista.length === 0 && (
          <div className="vacio">{todos.length === 0 ? 'Sin problemas en el último build.' : 'Ningún problema con este filtro.'}</div>
        )}
        {lista.map((p, i) => (
          <div
            key={`${i}:${p.severity}:${p.file}:${p.line}`}
            role="listitem"
            className={`problema ${p.severity}${p.kind.startsWith('lint-') ? ' lint' : ''}${i === actual ? ' actual' : ''}`}
            onClick={() => void ir(i)}
            title={p.context || p.message}
          >
            <span className="icono">{ICONO[p.severity]}</span>
            <span className="mensaje">{p.message}</span>
            <span className="donde">{p.file ? `${p.file.split('/').pop()}${p.line ? `:${p.line}` : ''}` : 'sin ubicación'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
