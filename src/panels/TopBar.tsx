// Barra superior: abrir carpeta, raíz del documento, Compilar / Cancelar y el resultado del último build.
import { useEffect, useState } from 'react';
import { useApp } from '../store/app';

function Cronometro({ activo }: { activo: boolean }) {
  const [seg, setSeg] = useState(0);
  useEffect(() => {
    if (!activo) return;
    const t0 = Date.now();
    setSeg(0);
    const t = setInterval(() => setSeg((Date.now() - t0) / 1000), 250);
    return () => clearInterval(t);
  }, [activo]);
  return <>{seg.toFixed(0)} s</>;
}

export function TopBar() {
  const project = useApp((s) => s.project);
  const rootFile = useApp((s) => s.rootFile);
  const build = useApp((s) => s.build);
  const abrirCarpeta = useApp((s) => s.abrirCarpeta);
  const elegirRaiz = useApp((s) => s.elegirRaiz);
  const compilar = useApp((s) => s.compilar);
  const cancelar = useApp((s) => s.cancelarBuild);
  const avisar = useApp((s) => s.avisar);
  const corriendo = build.status === 'running';
  const candidatas = project?.candidates ?? [];
  // La raíz puede ser un archivo que no está entre las candidatas (se eligió desde una pestaña).
  const opciones = rootFile && !candidatas.includes(rootFile) ? [rootFile, ...candidatas] : candidatas;

  return (
    <div className="barra-superior">
      <button className="boton" onClick={() => abrirCarpeta().catch((e) => avisar(String(e), 'error'))}>
        Abrir carpeta…
      </button>
      {project && (
        <>
          <span className="proyecto" title={project.root}>{project.name}</span>
          <label className="raiz">
            Raíz
            <select
              value={rootFile ?? ''}
              onChange={(e) => e.target.value && elegirRaiz(e.target.value).catch((er) => avisar(String(er), 'error'))}
              disabled={corriendo}
            >
              {!rootFile && <option value="">(elegir)</option>}
              {opciones.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          {corriendo ? (
            <button className="boton peligro" onClick={() => void cancelar()}>■ Cancelar</button>
          ) : (
            <button className="boton primario" onClick={() => void compilar()} disabled={!rootFile} title="Guardar todo y compilar (Ctrl+Enter)">
              ▶ Compilar
            </button>
          )}
          <span className={`estado-build ${build.status}`}>
            {build.status === 'running' && <>Compilando… <Cronometro activo /></>}
            {build.status === 'ok' && <>✔ {((build.ms ?? 0) / 1000).toFixed(1)} s</>}
            {build.status === 'fail' && <>✘ falló (código {build.code ?? '?'})</>}
            {build.status === 'cancelled' && <>Cancelado</>}
          </span>
        </>
      )}
    </div>
  );
}
