// Árbol de archivos. Perezoso: sólo se lista una carpeta cuando se abre (el libro tiene más de mil archivos en
// `figuras-cache/` y no tiene sentido pedirlos todos al abrir el proyecto).
import { useCallback, useEffect, useState } from 'react';
import { getBackend, type DirEntry } from '../backend';
import { useApp } from '../store/app';

export function FileTree() {
  const project = useApp((s) => s.project);
  const rootFile = useApp((s) => s.rootFile);
  const activeRel = useApp((s) => s.activeRel);
  const abrirArchivo = useApp((s) => s.abrirArchivo);
  const avisar = useApp((s) => s.avisar);
  const [hijos, setHijos] = useState<Record<string, DirEntry[]>>({});
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set(['']));

  const listar = useCallback(
    async (rel: string) => {
      try {
        const entradas = await getBackend().listDir(rel);
        setHijos((h) => ({ ...h, [rel]: entradas }));
      } catch (e) {
        avisar(`No se pudo listar ${rel || 'la carpeta'}: ${e instanceof Error ? e.message : e}`, 'error');
      }
    },
    [avisar],
  );

  // Al abrir otro proyecto se empieza de cero.
  useEffect(() => {
    setHijos({});
    setAbiertas(new Set(['']));
    if (project) void listar('');
  }, [project?.root, listar]);

  const alternar = (rel: string) => {
    setAbiertas((a) => {
      const n = new Set(a);
      if (n.has(rel)) n.delete(rel);
      else {
        n.add(rel);
        if (!hijos[rel]) void listar(rel);
      }
      return n;
    });
  };

  const refrescar = () => {
    const rels = [...abiertas];
    setHijos({});
    rels.forEach((r) => void listar(r));
  };

  const nodo = (e: DirEntry, nivel: number) => {
    const abierta = abiertas.has(e.rel);
    return (
      <div key={e.rel}>
        <div
          className={`fila${!e.is_dir && e.rel === activeRel ? ' activa' : ''}`}
          style={{ paddingLeft: 8 + nivel * 14 }}
          onClick={() => (e.is_dir ? alternar(e.rel) : void abrirArchivo(e.rel))}
          title={e.rel}
        >
          <span className="icono">{e.is_dir ? (abierta ? '▾' : '▸') : ''}</span>
          <span className="nombre">{e.name}</span>
          {e.rel === rootFile && <span className="marca" title="Raíz del documento">raíz</span>}
        </div>
        {e.is_dir && abierta && (hijos[e.rel] ?? []).map((h) => nodo(h, nivel + 1))}
      </div>
    );
  };

  if (!project) return <div className="vacio">Abrí una carpeta para empezar.</div>;
  return (
    <div className="arbol">
      <div className="arbol-cabecera">
        <span className="titulo" title={project.root}>{project.name}</span>
        <button className="icono-boton" onClick={refrescar} title="Volver a leer las carpetas abiertas">⟳</button>
      </div>
      <div className="arbol-cuerpo">{(hijos[''] ?? []).map((e) => nodo(e, 0))}</div>
    </div>
  );
}
