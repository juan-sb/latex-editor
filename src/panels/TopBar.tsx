// Barra superior (10.1 del plan): proyecto y raíz, perfil activo y partes, Compilar / Cancelar, modo de
// auto-compilación y el resultado del último build. El menú ⋯ tiene lo que se usa menos: variables, publicar, guardar
// latexviewer.json y qué hacer cuando se guarda un archivo de una parte que el perfil no incluye.
import { useEffect, useState } from 'react';
import type { AutoCompileMode, OutsideSave, Tipico } from '../backend';
import { perfilActivo, useApp } from '../store/app';
import { lineaDeBuild, textoDeTipico } from '../store/barra';
import { abrirPantallaProyecto } from '../store/proyecto';
import { textoDeProgreso } from '../store/figuras';
import { resumen } from '../store/problemas';
import { siguienteTema, textoDelTema, useTema } from '../store/tema';
import { Menu } from './Menu';

/** Los segundos que lleva el build (desde que se pidió) y, al lado, lo típico de ese perfil según el historial. */
function Cronometro({ desde, tipico }: { desde: number | null; tipico: Tipico | undefined }) {
  const [seg, setSeg] = useState(0);
  useEffect(() => {
    const t0 = desde ?? Date.now();
    const actualizar = () => setSeg((Date.now() - t0) / 1000);
    actualizar();
    const t = setInterval(actualizar, 250);
    return () => clearInterval(t);
  }, [desde]);
  const t = textoDeTipico(tipico, seg);
  return (
    <>
      {seg.toFixed(0)} s{t && <span className="tipico"> ({t})</span>}
    </>
  );
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
  const elegirPerfil = useApp((s) => s.elegirPerfil);
  const compilar = useApp((s) => s.compilar);
  const cancelar = useApp((s) => s.cancelarBuild);
  const setAutoCompile = useApp((s) => s.setAutoCompile);
  const setOutsideSave = useApp((s) => s.setOutsideSave);
  const setDraftImages = useApp((s) => s.setDraftImages);
  const setVariable = useApp((s) => s.setVariable);
  const publicar = useApp((s) => s.publicar);
  const mostrarPanel = useApp((s) => s.mostrarPanel);
  const figProgreso = useApp((s) => s.figProgreso);
  const exportando = useApp((s) => s.exportando);
  const exportPendiente = useApp((s) => s.exportPendiente);
  const menuCompilacion = useApp((s) => s.menuCompilacion);
  const mostrarPanelInferior = useApp((s) => s.mostrarPanelInferior);
  const avisar = useApp((s) => s.avisar);
  const tema = useTema((s) => s.tema);
  const alternarTema = useTema((s) => s.alternar);
  const corriendo = build.status === 'running';
  // Exportar es un trabajo más de la cola: mientras corre o espera, Cancelar lo corta.
  const ocupado = corriendo || exportando !== null;
  const config = project?.config ?? null;
  const estado = project?.state;
  const activo = perfilActivo(project);
  const visibles = config?.profiles.filter((p) => !p.hidden) ?? [];
  const partes = resumenDePartes(activo?.parts, estado?.selection ?? [], project?.parts.length ?? 0);
  // Siempre la etiqueta, también durante el build (antes mostraba el id con «…»).
  const etiquetaPerfil = (id: string) => config?.profiles.find((p) => p.id === id)?.label ?? id;
  const tipicos = useApp((s) => s.tipicos);
  // Lo que compila el build en curso (puede no ser el perfil activo: quedó en cola o lo pidió un menú).
  const enCurso = config?.profiles.find((p) => p.id === build.perfil);
  const partesEnCurso = enCurso ? resumenDePartes(enCurso.parts, estado?.selection ?? [], project?.parts.length ?? 0) : '';

  return (
    <div className="barra-superior">
      <button className="boton" onClick={() => abrirCarpeta().catch((e) => avisar(String(e), 'error'))}>
        Abrir carpeta…
      </button>
      {project && (
        <>
          <span className="proyecto" title={project.root}>{project.name}</span>
          <button
            className="icono-boton config-proyecto"
            onClick={() => void abrirPantallaProyecto()}
            title="Configurar el proyecto: documento principal, partes, perfiles, salidas, variables"
            aria-label="Configurar el proyecto"
          >
            ⚙
          </button>
          {/* La raíz ya no se elige acá: está en latexviewer.json y se cambia desde la pantalla Proyecto (F8b). */}
          <button
            className="boton chico raiz-actual"
            onClick={() => void abrirPantallaProyecto()}
            title={rootFile ? `Documento principal: ${rootFile}. Clic para configurar el proyecto (raíz, partes, perfiles, salidas…)` : 'Elegir el documento principal y configurar el proyecto'}
          >
            {rootFile ?? 'Elegir el documento…'}
          </button>
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
              {ocupado ? (
                <button className="boton peligro" onClick={() => void cancelar()}>■ Cancelar</button>
              ) : (
                <button className="boton primario" onClick={() => void compilar()} disabled={!rootFile} title="Guardar todo y compilar el perfil activo (Ctrl+Enter)">
                  ▶ Compilar
                </button>
              )}
              <button
                className={`boton chico${estado.draftImages ? ' activo' : ''}`}
                onClick={() => void setDraftImages(!estado.draftImages)}
                title={
                  estado.draftImages
                    ? 'Imágenes en borrador: se dibujan como cajas del tamaño que tendrían, sin procesarlas (más rápido). No vale para lo que se publica ni se exporta. Clic para volver a las completas.'
                    : 'Imágenes completas. Clic para compilar con las imágenes en borrador (cajas del tamaño que tendrían, sin procesarlas).'
                }
              >
                🖼 {estado.draftImages ? 'Borrador' : 'Imágenes'}
              </button>
              <button className="boton chico" onClick={() => menuCompilacion()} title="Menú de compilación: perfiles, variables, exportar, cocinar, limpiar (Ctrl+Alt+T)">
                ☰
              </button>
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
                <button className="menu-item" data-cierra onClick={() => void abrirPantallaProyecto()}>
                  Configurar el proyecto…
                </button>
              </Menu>
            </>
          )}
          {(build.status === 'ok' || build.status === 'fail') && resumen(build.errors ?? 0, build.warnings ?? 0, 0) && (
            <button className={`problemas-resumen ${build.errors ? 'error' : 'warning'}`} onClick={() => mostrarPanelInferior('problemas')} title="Ver los problemas">
              {resumen(build.errors ?? 0, build.warnings ?? 0, 0)}
            </button>
          )}
          {figProgreso && (
            <button className="figuras-barra" onClick={() => mostrarPanel('figuras')} title="Ver el panel Figuras">
              {textoDeProgreso(figProgreso)}
            </button>
          )}
          {(exportando || exportPendiente) && (
            <button className="exportar-barra" onClick={() => mostrarPanelInferior('log')} title="Ver el log de la exportación">
              {exportando
                ? `Exportando ${Math.min(exportando.hechas + 1, exportando.total)}/${exportando.total}${exportando.parte ? ` · listo «${nombreCorto(exportando.parte)}»` : ''}`
                : 'Exportación en espera'}
            </button>
          )}
          <span className={`estado-build ${build.status}`}>
            {build.status === 'running' && (
              <>
                {figProgreso && build.id === null
                  ? 'Esperando las figuras…'
                  : lineaDeBuild({ perfil: build.perfil ? etiquetaPerfil(build.perfil) : '…', partes: partesEnCurso, paso: build.paso, figura: build.figura })}{' '}
                <Cronometro desde={build.inicioMs} tipico={build.perfil ? tipicos[build.perfil] : undefined} />
                {build.pendiente && <span className="pendiente" title="Se compila una vez más cuando termine"> · 1 pendiente</span>}
              </>
            )}
            {build.status === 'ok' && (
              <>
                ✔ {((build.ms ?? 0) / 1000).toFixed(1)} s{build.passes ? ` · ${build.passes} pasada${build.passes === 1 ? '' : 's'}` : ''}
                {build.repaired && ' · reparado'}
                {build.borrador && <span className="borrador" title="El PDF tiene cajas del tamaño de cada imagen en lugar de las imágenes"> · imágenes en borrador</span>}
              </>
            )}
            {build.status === 'fail' && <>✘ falló (código {build.code ?? '?'})</>}
            {build.status === 'cancelled' && <>Cancelado</>}
          </span>
        </>
      )}
      <button
        className={`icono-boton tema-boton${project ? '' : ' solo'}`}
        onClick={() => void alternarTema()}
        title={`Tema: ${textoDelTema(tema)}. Clic para pasar a ${textoDelTema(siguienteTema(tema))}.`}
        aria-label={`Tema: ${textoDelTema(tema)}`}
      >
        {tema === 'claro' ? '☀' : tema === 'oscuro' ? '🌙' : '🖥'}
      </button>
    </div>
  );
}
