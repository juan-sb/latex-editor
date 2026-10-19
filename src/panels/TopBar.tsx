// Barra superior (10.1 del plan): proyecto y raíz, perfil activo y partes, Compilar / Cancelar, modo de
// auto-compilación y el resultado del último build. El menú ⋯ tiene lo que se usa menos: variables, publicar, guardar
// latexviewer.json y qué hacer cuando se guarda un archivo de una parte que el perfil no incluye.
import { useEffect, useState } from 'react';
import type { AutoCompileMode, OutsideSave } from '../backend';
import { perfilActivo, useApp } from '../store/app';
import { resumen } from '../store/problemas';
import { Menu } from './Menu';

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

const nombreCorto = (n: string) => n.split('/').pop() ?? n;

/** "Desnormalización", "3 partes" o "todas las partes": lo que compila el perfil activo, en una frase corta. */
export function resumenDePartes(parts: 'selection' | 'all' | 'one' | undefined, seleccion: string[], total: number): string {
  if (parts === 'selection') {
    if (seleccion.length === 0) return 'ninguna parte';
    if (seleccion.length === 1) return nombreCorto(seleccion[0]);
    return `${seleccion.length} de ${total} partes`;
  }
  if (parts === 'all') return total > 0 ? `todas las partes (${total})` : 'todo el documento';
  return '';
}

export function TopBar() {
  const project = useApp((s) => s.project);
  const rootFile = useApp((s) => s.rootFile);
  const build = useApp((s) => s.build);
  const abrirCarpeta = useApp((s) => s.abrirCarpeta);
  const elegirRaiz = useApp((s) => s.elegirRaiz);
  const elegirPerfil = useApp((s) => s.elegirPerfil);
  const compilar = useApp((s) => s.compilar);
  const cancelar = useApp((s) => s.cancelarBuild);
  const setAutoCompile = useApp((s) => s.setAutoCompile);
  const setOutsideSave = useApp((s) => s.setOutsideSave);
  const setVariable = useApp((s) => s.setVariable);
  const publicar = useApp((s) => s.publicar);
  const guardarConfig = useApp((s) => s.guardarConfig);
  const mostrarPanel = useApp((s) => s.mostrarPanel);
  const mostrarPanelInferior = useApp((s) => s.mostrarPanelInferior);
  const avisar = useApp((s) => s.avisar);
  const corriendo = build.status === 'running';
  const candidatas = project?.candidates ?? [];
  // La raíz puede ser un archivo que no está entre las candidatas (se eligió desde una pestaña).
  const opciones = rootFile && !candidatas.includes(rootFile) ? [rootFile, ...candidatas] : candidatas;
  const config = project?.config ?? null;
  const estado = project?.state;
  const activo = perfilActivo(project);
  const visibles = config?.profiles.filter((p) => !p.hidden) ?? [];
  const partes = resumenDePartes(activo?.parts, estado?.selection ?? [], project?.parts.length ?? 0);
  const etiquetaPerfil = (id: string) => build.perfil === id && corriendo ? `${id} …` : (config?.profiles.find((p) => p.id === id)?.label ?? id);

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
          {config && estado && (
            <>
              <label className="raiz">
                Perfil
                <select value={estado.activeProfile ?? ''} onChange={(e) => void elegirPerfil(e.target.value)} title="Lo que compila Ctrl+S y Compilar">
                  {visibles.map((p) => (
                    <option key={p.id} value={p.id}>{etiquetaPerfil(p.id)}</option>
                  ))}
                </select>
              </label>
              {partes && (
                <button className="boton chico partes-resumen" onClick={() => mostrarPanel('partes')} title="Ver y elegir las partes">
                  {partes}
                </button>
              )}
              {corriendo ? (
                <button className="boton peligro" onClick={() => void cancelar()}>■ Cancelar</button>
              ) : (
                <button className="boton primario" onClick={() => void compilar()} disabled={!rootFile} title="Guardar todo y compilar el perfil activo (Ctrl+Enter)">
                  ▶ Compilar
                </button>
              )}
              <label className="raiz" title="Cuándo se compila solo">
                Auto
                <select value={estado.autoCompile} onChange={(e) => void setAutoCompile(e.target.value as AutoCompileMode)}>
                  <option value="save">al guardar</option>
                  <option value="idle">al dejar de tipear</option>
                  <option value="manual">manual</option>
                </select>
              </label>
              <Menu etiqueta="⋯" titulo="Más opciones">
                {config.variables.length > 0 && (
                  <div className="menu-grupo">
                    <div className="menu-titulo">Variables</div>
                    {config.variables.map((v) => (
                      <label key={v.name} className="menu-fila">
                        <span>{v.label}</span>
                        <select value={estado.variables[v.name] ?? v.default ?? ''} onChange={(e) => void setVariable(v.name, e.target.value)}>
                          {v.choices.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
                <div className="menu-grupo">
                  <div className="menu-titulo">Si guardo un archivo de otra parte</div>
                  <label className="menu-fila">
                    <select value={estado.outsideSave} onChange={(e) => void setOutsideSave(e.target.value as OutsideSave)}>
                      <option value="warn">avisar</option>
                      <option value="switch">cambiar la selección y compilar</option>
                      <option value="build">compilar igual</option>
                    </select>
                  </label>
                </div>
                <button className="menu-item" data-cierra onClick={() => void publicar()} disabled={!config.publishDir || corriendo} title={config.publishDir ? `Copia el PDF a ${config.publishDir}` : 'El proyecto no define publish.dir'}>
                  Publicar el PDF del último build
                </button>
                {!project.configSaved && (
                  <button className="menu-item" data-cierra onClick={() => void guardarConfig()}>
                    Guardar latexviewer.json
                  </button>
                )}
              </Menu>
            </>
          )}
          {(build.status === 'ok' || build.status === 'fail') && resumen(build.errors ?? 0, build.warnings ?? 0, 0) && (
            <button className={`problemas-resumen ${build.errors ? 'error' : 'warning'}`} onClick={() => mostrarPanelInferior('problemas')} title="Ver los problemas">
              {resumen(build.errors ?? 0, build.warnings ?? 0, 0)}
            </button>
          )}
          <span className={`estado-build ${build.status}`}>
            {build.status === 'running' && (
              <>
                Compilando «{build.perfil ?? '…'}»… <Cronometro activo />
                {build.pendiente && <span className="pendiente" title="Se compila una vez más cuando termine"> · 1 pendiente</span>}
              </>
            )}
            {build.status === 'ok' && (
              <>
                ✔ {((build.ms ?? 0) / 1000).toFixed(1)} s{build.passes ? ` · ${build.passes} pasada${build.passes === 1 ? '' : 's'}` : ''}
                {build.repaired && ' · reparado'}
              </>
            )}
            {build.status === 'fail' && <>✘ falló (código {build.code ?? '?'})</>}
            {build.status === 'cancelled' && <>Cancelado</>}
          </span>
        </>
      )}
    </div>
  );
}
