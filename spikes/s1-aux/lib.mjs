// Utilidades de los spikes que compilan el libro (S1). Todo corre sobre copias en spikes/work/.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const repo = path.resolve(import.meta.dirname, '..', '..');
export const ROOT = 'Funciones de Aproximación';
export const PARTE_TRABAJO = 'Secciones/Desnormalización';

export function run(cmd, args, { cwd, env } = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), s: Number(process.hrtime.bigint() - t0) / 1e9 };
}

export const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
export const pasadas = (out) => (out.match(/Run number \d+ of rule 'pdflatex'/g) ?? []).length;

/** Recorre archivos de `dir` (recursivo), salteando carpetas por nombre. */
export function* archivos(dir, saltear = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!saltear.includes(e.name)) yield* archivos(p, saltear); }
    else yield p;
  }
}

/** Sello de estilo: 6 hex del md5 de estilo_figuras.tex, como structure.tex. */
export const sello = (P) =>
  crypto.createHash('md5').update(fs.readFileSync(path.join(P, 'estilo_figuras.tex'))).digest('hex').slice(0, 6).toUpperCase();

/** Copia tibia del libro (cache de figuras incluido) a spikes/work/<nombre>/Proyecto, sin auxiliares ni build previos. */
export function preparar(nombre) {
  const r = run('powershell', ['-NoProfile', '-File', path.join(repo, 'scripts', 'copiar-libro.ps1'),
    '-Limpio', '-Origen', 'fixtures\\libro-tc', '-Destino', `spikes\\work\\${nombre}\\Proyecto`]);
  if (r.code !== 0) throw new Error('copiar-libro falló: ' + r.out);
  const P = path.join(repo, 'spikes', 'work', nombre, 'Proyecto');
  const S = sello(P);
  for (const f of fs.readdirSync(path.join(P, 'figuras-cache'))) {
    if (!f.startsWith(S + '-')) fs.rmSync(path.join(P, 'figuras-cache', f));
  }
  // Estado de partida limpio para los perfiles de la app: ni .aux ni .fdb_latexmk de la línea de base.
  const borrar = new Set(['.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind',
    '.lof', '.lot', '.out', '.log', '.gz', '.auxlock']);
  for (const f of [...archivos(P, ['figuras-cache', '.lv'])]) {
    if (borrar.has(path.extname(f).toLowerCase()) || f.endsWith('.run.xml')) fs.rmSync(f);
  }
  return { P, SELLO: S, PDFDIR: path.join(repo, 'spikes', 'work', nombre, 'PDF') };
}

/** Partes tal como las trae libro_cuerpo.tex: ["Secciones/Funciones de Aproximación", ...]. */
export function partes(P) {
  return [...leer(path.join(P, 'libro_cuerpo.tex')).matchAll(/^\s*\\Capitulo\{([^}]+)\}/gm)].map((m) => m[1]);
}

/** mtime de cada PDF del cache de figuras (raíz y cachés dentro de .lv/build/*). */
export function fotoCache(P) {
  const m = new Map();
  const dirs = [path.join(P, 'figuras-cache')];
  const b = path.join(P, '.lv', 'build');
  if (fs.existsSync(b)) for (const d of fs.readdirSync(b)) dirs.push(path.join(b, d, 'figuras-cache'));
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.pdf')) m.set(path.relative(P, path.join(d, f)), fs.statSync(path.join(d, f)).mtimeMs);
  }
  return m;
}
export const cocinadas = (antes, despues) => [...despues].filter(([k, v]) => antes.get(k) !== v).map(([k]) => k);

/** Dónde quedaron los .md5 de pgf. */
export function dondeMd5(P) {
  const r = {};
  for (const f of archivos(P, ['Secciones', 'Pictures', 'Imagenes', 'Herramientas'])) {
    if (f.endsWith('.md5')) { const d = path.relative(P, path.dirname(f)); r[d] = (r[d] ?? 0) + 1; }
  }
  return r;
}

/** Copia `de` a `a` sólo si el contenido difiere (así no se toca el mtime de lo que ya es igual). */
export function copiarSiDifiere(de, a) {
  fs.mkdirSync(path.dirname(a), { recursive: true });
  if (fs.existsSync(a) && fs.readFileSync(de).equals(fs.readFileSync(a))) return false;
  fs.copyFileSync(de, a);
  return true;
}

/** Líneas "Input:" de un .synctex.gz: cómo guardó TeX las rutas de los fuentes. */
export function synctexInputs(gz) {
  const t = zlib.gunzipSync(fs.readFileSync(gz)).toString('latin1');
  return t.split('\n').filter((l) => l.startsWith('Input:')).map((l) => l.slice(0, 200));
}

/** Referencias sin resolver: avisos del log y "??" en el texto del PDF. */
export function refsSinResolver(logFile, pdf) {
  const log = leer(logFile);
  const avisos = (log.match(/LaTeX Warning: (Reference|Citation) `[^']*' on page \d+ undefined/g) ?? []).length;
  const txt = run('pdftotext', ['-layout', pdf, '-']).out;
  return { avisos_log: avisos, signos_pdf: (txt.match(/\?\?/g) ?? []).length };
}
