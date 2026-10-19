// Panel Esquema (10.1 del plan): capítulos y secciones de todo el proyecto en el orden del documento, con su etiqueta. Las
// que abren una parte tienen la casilla del panel Partes; las partes que el perfil activo compila van resaltadas.
import { perfilActivo, useApp } from '../store/app';

const NIVELES = ['parte', 'capítulo', 'sección', 'subsección', 'subsubsección', 'párrafo', 'subpárrafo'];

export function EsquemaPanel() {
  const project = useApp((s) => s.project);
  const simbolos = useApp((s) => s.simbolos);
  const activeRel = useApp((s) => s.activeRel);
  const ir = useApp((s) => s.irAUbicacion);
  const alternar = useApp((s) => s.alternarParte);

  if (!project) return <div className="vacio">Abrí una carpeta para empezar.</div>;
  if (!simbolos) return <div className="vacio">Leyendo el proyecto…</div>;
  if (simbolos.sections.length === 0) return <div className="vacio">No hay capítulos ni secciones en los archivos del proyecto.</div>;

  const perfil = perfilActivo(project);
  const eligen = perfil?.parts === 'selection';
  const seleccion = project.state.selection;
  // La primera sección de un archivo que es una parte es la que lleva la casilla.
  const parteDe = new Map(project.parts.filter((p) => p.file).map((p) => [p.file as string, p.name]));
  const yaConCasilla = new Set<string>();
  const etiquetas = simbolos.labels.length;

  return (
    <div className="esquema">
      <div className="esquema-lista">
        {simbolos.sections.map((s, i) => {
          const parte = parteDe.get(s.file);
          const conCasilla = !!parte && !yaConCasilla.has(s.file);
          if (conCasilla) yaConCasilla.add(s.file);
          const marcada = !!parte && seleccion.includes(parte);
          const enPerfil = !!parte && (perfil?.parts === 'all' || (eligen && marcada));
          return (
            <div
              key={`${s.file}:${s.line}:${i}`}
              className={`esquema-item nivel-${Math.min(s.level, 4)}${s.file === activeRel ? ' del-archivo' : ''}${enPerfil ? ' en-perfil' : ''}`}
              style={{ paddingLeft: 8 + Math.max(0, s.level - 1) * 14 }}
              title={`${NIVELES[s.level] ?? 'sección'} · ${s.file}:${s.line}`}
              onClick={() => void ir(s.file, s.line)}
            >
              {conCasilla ? (
                <input
                  type="checkbox"
                  checked={marcada}
                  disabled={!eligen || (marcada && seleccion.length === 1)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => parte && void alternar(parte)}
                  title="Incluir esta parte en el perfil de partes elegidas"
                />
              ) : (
                <span className="esquema-hueco" />
              )}
              <span className="titulo">{s.title || '(sin título)'}</span>
              {s.label && <span className="etiqueta">{s.label}</span>}
            </div>
          );
        })}
      </div>
      <div className="partes-pie">
        {simbolos.sections.length} secciones · {etiquetas} etiquetas · {simbolos.scan_ms} ms
      </div>
    </div>
  );
}
