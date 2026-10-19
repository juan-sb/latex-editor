// Prototipo del generador de drivers de plan.md 4.2. En F2 esto pasa a Rust (lv-core/build);
// acá sólo sirve para los spikes S4 y S1.
//
// Un driver es un .tex ASCII por perfil que define los flags, las variables y el \includeonly
// y después hace \input de la raíz real del proyecto. Se escribe sólo si cambió, para no tocar su
// mtime (latexmk lo toma como "cambió el fuente" y rehace una pasada).
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} o
 * @param {string} o.perfil         nombre del perfil (ASCII, sin espacios): es el jobname
 * @param {string} o.root           raíz del proyecto, relativa, con o sin .tex
 * @param {string[]} [o.flags]      macros que se definen vacías antes de cargar la raíz
 * @param {Record<string,string>} [o.vars]  variables: \def\Nombre{valor}
 * @param {string[]|null} [o.includeonly]   partes a incluir; [] = ninguna; null = no tocar
 * @param {boolean} [o.parcial]
 * @param {'quoted'|'bare'|'ext'} [o.rootStyle]  cómo se escribe el \input de la raíz (prueba S4)
 * @param {string[]} [o.extraLines] líneas que van tal cual antes del \input de la raíz
 */
export function renderDriver(o) {
  const L = [];
  L.push(`% .lv/drivers/lv-${o.perfil}.tex (generado por LaTeX Viewer, no editar)`);
  L.push(`\\def\\lvPerfil{${o.perfil}}`);
  L.push(`\\def\\lvParcial{${o.parcial ? '1' : '0'}}`);
  for (const f of o.flags ?? []) L.push(`\\def\\${f}{}`);
  for (const [k, v] of Object.entries(o.vars ?? {})) L.push(`\\def\\${k}{${v}}`);
  for (const l of o.extraLines ?? []) L.push(l);
  if (o.includeonly) {
    // \includeonly sólo vale en el preámbulo; el hook corre al principio de \begin{document},
    // antes de que LaTeX lo prohíba, y así no hace falta editar la raíz del usuario.
    L.push(`\\AddToHook{begindocument/before}{\\includeonly{${o.includeonly.join(',')}}}`);
  }
  const base = o.root.replace(/\.tex$/i, '');
  const style = o.rootStyle ?? 'quoted';
  if (style === 'quoted') L.push(`\\input{"${base}"}`);
  else if (style === 'bare') L.push(`\\input{${base}}`);
  else L.push(`\\input{"${base}.tex"}`);
  return L.join('\n') + '\n';
}

/** Escribe el driver sólo si cambió. UTF-8 sin BOM. Devuelve true si escribió. */
export function writeIfChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text, { encoding: 'utf8' });
  return true;
}

// CLI: node gen-driver.mjs <proyecto> <perfil> <raíz> [--parcial] [--flag X]... [--var K=V]... [--only a,b] [--style quoted|bare|ext]
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [proj, perfil, root, ...rest] = process.argv.slice(2);
  const o = { perfil, root, flags: [], vars: {}, includeonly: null, parcial: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--parcial') o.parcial = true;
    else if (a === '--flag') o.flags.push(rest[++i]);
    else if (a === '--var') { const [k, ...v] = rest[++i].split('='); o.vars[k] = v.join('='); }
    else if (a === '--only') o.includeonly = rest[++i] === '' ? [] : rest[i].split(',');
    else if (a === '--style') o.rootStyle = rest[++i];
  }
  const file = path.join(proj, '.lv', 'drivers', `lv-${perfil}.tex`);
  const wrote = writeIfChanged(file, renderDriver(o));
  console.log(`${wrote ? 'escrito' : 'sin cambios'}: ${file}`);
}
