// Panel Figuras (10.1 del plan): el cache de figuras del proyecto. Sello de hoy, cuántas están al día, pendientes o fallidas,
// cuánto pesa el cache y cuánto de eso es de sellos viejos; Cocinar (en paralelo), Cancelar y Limpiar (con vista previa). Las
// figuras van por archivo, y una que falló trae su error: un clic lleva a la línea de la fuente, y otro abre su `.log`.
import { useEffect } from 'react';
import { useApp } from '../store/app';
import { agruparFiguras, megabytes, resumenDeFiguras, textoDeProgreso } from '../store/figuras';

const ICONO = { aldia: '●', pendiente: '○', falta: '○', fallo: '✘' } as const;

export function FigurasPanel() {
  const project = useApp((s) => s.project);
  const f = useApp((s) => s.figuras);
  const progreso = useApp((s) => s.figProgreso);
  const pendiente = useApp((s) => s.figPendiente);
  const cocinar = useApp((s) => s.cocinarFiguras);
  const limpiar = useApp((s) => s.limpiarFiguras);
  const cancelar = useApp((s) => s.cancelarBuild);
  const cargar = useApp((s) => s.cargarFiguras);
  const ir = useApp((s) => s.irAUbicacion);
  const abrir = useApp((s) => s.abrirArchivo);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!project) return <div className="vacio">Abrí una carpeta para empezar.</div>;
  if (!f) return <div className="vacio">Leyendo el cache de figuras…</div>;
  if (f.modo === 'off') {
    return (
      <div className="vacio">
        El cache de figuras está apagado. Se enciende con <code>figureCache.mode</code> en <code>latexviewer.json</code> (<code>project</code> si el
        documento ya externaliza sus figuras, <code>app</code> si querés que la app lo haga).
      </div>
    );
  }
  const grupos = agruparFiguras(f.figuras);
  const cocinando = progreso !== null;
  const mbViejos = megabytes(f.bytesViejos);

  return (
    <div className="figuras">
      <div className="partes-cabecera">
        <span className="titulo">Figuras</span>
        <button className="boton chico" onClick={() => void cocinar()} disabled={cocinando} title="Lista las figuras del documento y cocina en paralelo las que falten o cambiaron">
          Cocinar
        </button>
        {cocinando && (
          <button className="boton chico peligro" onClick={() => void cancelar()} title="Cancela la cocción: ninguna figura queda a medio hacer">
            Cancelar
          </button>
        )}
        <button className="boton chico" onClick={() => void limpiar()} disabled={cocinando || !f.figlist?.completa || !f.figlist.delSelloDeHoy || !f.figlist.vale} title="Borra lo que el documento ya no usa (te muestra cuánto antes)">
          Limpiar
        </button>
      </div>
      {cocinando && (
        <div className="figuras-progreso" role="progressbar" aria-valuenow={progreso.hechas} aria-valuemax={progreso.total}>
          <div className="barra" style={{ width: progreso.listando || progreso.total === 0 ? '8%' : `${Math.round((100 * progreso.hechas) / progreso.total)}%` }} />
          <span>{textoDeProgreso(progreso)}</span>
        </div>
      )}
      {pendiente && !cocinando && <div className="partes-nota">Hay una cocción esperando a que termine lo que se está haciendo.</div>}
      <div className="figuras-resumen">
        <div>
          Sello <code>{f.sello ?? '?'}</code> · {f.actuales} figura{f.actuales === 1 ? '' : 's'} del sello de hoy
          {f.necesitaCocer && <span className="aviso-chico"> · hay que cocinar antes de compilar</span>}
        </div>
        <div>{resumenDeFiguras(f) || 'Todavía no se listaron las figuras: Cocinar las lista y cocina las que falten.'}</div>
        <div className="suave">
          Cache: {megabytes(f.bytes)} MB en <code>{f.dir}</code>
          {f.viejas > 0 && ` · ${f.viejas} de sellos anteriores (${mbViejos} MB)`}
          {f.figlist && !f.figlist.completa && ' · la última lista es de un perfil parcial: no se puede limpiar'}
          {f.figlist && f.figlist.completa && !f.figlist.delSelloDeHoy && ' · la lista es de otro sello: no se puede limpiar'}
          {f.figlist && f.figlist.completa && f.figlist.delSelloDeHoy && !f.figlist.vale && ' · la lista es de otra raíz o de otras partes: cociná todo antes de limpiar'}
        </div>
      </div>
      {f.errores.length > 0 && (
        <div className="figuras-errores">
          {f.errores.map((e) => (
            <div key={e.nombre} className="figura-error">
              <span className="mensaje" title={e.mensaje}>{e.mensaje}</span>
              {e.file && e.line !== null && (
                <button className="icono-boton" onClick={() => void ir(e.file as string, e.line as number)} title="Ir a la línea de la fuente">
                  {e.file.split('/').pop()}:{e.line}
                </button>
              )}
              <button className="icono-boton" onClick={() => void abrir(e.log)} title="Abrir el .log de la subcompilación">log</button>
            </div>
          ))}
        </div>
      )}
      <div className="figuras-lista">
        {grupos.map((g) => (
          <div key={g.archivo ?? '(sin archivo)'} className="figuras-grupo">
            <div className="figuras-grupo-cab" onClick={() => g.archivo && void abrir(g.archivo)} title={g.archivo ?? 'Figuras que no se pudieron atribuir a un archivo'}>
              <span className="nombre">{g.archivo ?? '(sin archivo)'}</span>
              <span className="contador">
                {g.aldia}/{g.figuras.length}
                {g.fallos > 0 && <span className="fallo"> · {g.fallos} ✘</span>}
              </span>
            </div>
            {g.figuras.map((x) => (
              <div key={x.nombre} className={`figura ${x.estado}`} title={`${x.nombre} · ${(x.bytes / 1024).toFixed(0)} KB`}>
                <span className="icono">{ICONO[x.estado]}</span>
                <span className="nombre">{x.nombre.split('/').pop()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
