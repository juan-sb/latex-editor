// Panel Partes (10.1 del plan): las partes del proyecto con una casilla cada una. Las tildadas son lo que compila un
// perfil de "partes elegidas". "Sólo esta" deja una; ▶ la compila de una vez; la del archivo abierto va resaltada.
import { perfilActivo, useApp } from '../store/app';

const nombreCorto = (n: string) => n.split('/').pop() ?? n;

export function PartsPanel() {
  const project = useApp((s) => s.project);
  const parteActiva = useApp((s) => s.parteActiva);
  const alternar = useApp((s) => s.alternarParte);
  const solo = useApp((s) => s.soloParte);
  const todas = useApp((s) => s.todasLasPartes);
  const compilarParte = useApp((s) => s.compilarParte);
  const compilarActiva = useApp((s) => s.compilarParteActiva);
  const abrirArchivo = useApp((s) => s.abrirArchivo);

  if (!project) return <div className="vacio">Abrí una carpeta para empezar.</div>;
  const partes = project.parts;
  if (partes.length === 0) {
    return (
      <div className="vacio">
        Este proyecto no tiene partes (<code>\include</code> o los comandos de <code>parts.commands</code>). Se compila el documento
        entero.
      </div>
    );
  }
  const perfil = perfilActivo(project);
  const eligen = perfil?.parts === 'selection';
  const seleccion = project.state.selection;

  return (
    <div className="partes">
      <div className="partes-cabecera">
        <span className="titulo">Partes</span>
        <button className="boton chico" onClick={() => void todas()} disabled={!eligen} title="Tildar todas">Todas</button>
        <button className="boton chico" onClick={() => void compilarActiva()} disabled={!parteActiva} title="Compilar la parte del archivo abierto">
          Esta
        </button>
      </div>
      {!eligen && (
        <div className="partes-nota">
          El perfil «{perfil?.label ?? '?'}» compila {perfil?.parts === 'all' ? 'todas las partes' : 'el documento completo'}: la
          selección vale para los perfiles de partes elegidas.
        </div>
      )}
      <div className="partes-lista">
        {partes.map((p) => {
          const marcada = seleccion.includes(p.name);
          return (
            <div key={p.name} className={`parte${p.name === parteActiva ? ' activa' : ''}${eligen && !marcada ? ' apagada' : ''}`}>
              <input
                type="checkbox"
                checked={marcada}
                disabled={!eligen || (marcada && seleccion.length === 1)}
                onChange={() => void alternar(p.name)}
                title={marcada && seleccion.length === 1 ? 'Tiene que quedar al menos una parte' : 'Incluir en el perfil de partes elegidas'}
              />
              <span className="nombre" title={p.file ?? p.name} onDoubleClick={() => p.file && void abrirArchivo(p.file)}>
                {nombreCorto(p.name)}
              </span>
              <button className="icono-boton" onClick={() => void solo(p.name)} disabled={!eligen} title="Sólo esta parte">1</button>
              <button className="icono-boton" onClick={() => void compilarParte(p.name)} title="Compilar sólo esta parte">▶</button>
            </div>
          );
        })}
      </div>
      <div className="partes-pie">
        {seleccion.length} de {partes.length} elegidas · {project.indexMs} ms de índice
      </div>
    </div>
  );
}
