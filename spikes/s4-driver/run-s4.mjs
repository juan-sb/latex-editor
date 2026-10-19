// Spike S4: \includeonly inyectado por hook y flags en un driver, compilando el libro con su
// raíz real. Corre sobre una copia tibia del libro (spikes/work/s4/Proyecto) y deja los
// resultados crudos en spikes/work/s4/resultados.json. Las conclusiones van a docs/spikes/S4.md.
//
// Uso: node spikes/s4-driver/run-s4.mjs [--sin-copiar]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderDriver, writeIfChanged } from './gen-driver.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const work = path.join(repo, 'spikes', 'work', 's4');
const P = path.join(work, 'Proyecto');
const PDFDIR = path.join(work, 'PDF');
const ROOT = 'Funciones de Aproximación';
const PARTE = 'Secciones/Desnormalización';

function run(cmd, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: P, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  const s = Number(process.hrtime.bigint() - t0) / 1e9;
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), s };
}
const latexmk = (src, extra = []) => run('latexmk', [
  '-pdf', '-shell-escape', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', ...extra, src]);
const pasadas = (out) => (out.match(/Run number \d+ of rule 'pdflatex'/g) ?? []).length;
const pdfPath = (job) => path.join(PDFDIR, `${job}.pdf`);
const texto = (pdf) => spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\f');
const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

const res = {};
const nota = (k, v) => { res[k] = v; console.log(k.padEnd(34), typeof v === 'object' ? JSON.stringify(v) : v); };

if (!process.argv.includes('--sin-copiar')) {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(repo, 'scripts', 'copiar-libro.ps1'),
    '-Limpio', '-Origen', 'fixtures\\libro-tc', '-Destino', 'spikes\\work\\s4\\Proyecto'], { encoding: 'utf8' });
  console.log(r.stdout.trim());
  if (r.status !== 0) throw new Error('falló copiar-libro: ' + r.stderr);
}

// Sello de estilo actual (6 hex del md5 de estilo_figuras.tex, como structure.tex). La copia trae
// el cache de varios sellos de la línea de base; acá se deja sólo el actual.
const SELLO = crypto.createHash('md5').update(fs.readFileSync(path.join(P, 'estilo_figuras.tex'))).digest('hex').slice(0, 6).toUpperCase();
for (const f of fs.readdirSync(path.join(P, 'figuras-cache'))) {
  if (!f.startsWith(SELLO + '-')) fs.rmSync(path.join(P, 'figuras-cache', f));
}
nota('sello_actual', SELLO);

// Referencia: el PDF de cap_actual que dejó la línea de base (misma raíz, mismo capítulo).
const refPdf = pdfPath('cap_actual');
if (!fs.existsSync(refPdf)) throw new Error('falta cap_actual.pdf de referencia en ' + PDFDIR);
const refTexto = texto(refPdf);
nota('ref_paginas', refTexto.length - 1);

// --- T1/T3/T4: driver parcial como en 4.2 del plan -------------------------------------------
const drvPath = (n) => path.join(P, '.lv', 'drivers', `lv-${n}.tex`);
// Con el cache de la copia tibio, externalizar desde un driver fuera del cwd anda mientras pgf no
// necesite lanzar subcompilaciones (T8 es el caso en que sí). Sin el flag cada variante dibujaba
// las 46 figuras en línea y tardaba 136 s por pasada.
const base = { root: ROOT, parcial: true, flags: ['CompilacionReducida', 'TikzExternalizar'], includeonly: [PARTE] };
writeIfChanged(drvPath('parcial'), renderDriver({ ...base, perfil: 'parcial' }));
nota('driver_parcial', leer(drvPath('parcial')));

// Sin externalizar primero: aísla el hook y los flags del problema del cache.
const a = latexmk('.lv/drivers/lv-parcial.tex');
const logA = leer(path.join(P, 'lv-parcial.log'));
nota('T1_parcial_sin_cache', { codigo: a.code, s: +a.s.toFixed(1), pasadas: pasadas(a.out) });
nota('T1_pdf_en_PDFDIR', fs.existsSync(pdfPath('lv-parcial')));
const entra = [...logA.matchAll(/\(\.?\/?(Secciones\/[^\s()]+\.tex)/g)].map((m) => m[1]);
nota('T1_partes_que_entraron_por_log', [...new Set(entra)].filter((f) => !/fig_|Anexo/.test(f)));
nota('T3_jobname', /\*\*[^\n]*lv-parcial/.test(logA) || fs.existsSync(path.join(P, 'lv-parcial.aux')));
nota('T4_sin_idx', !fs.existsSync(path.join(P, 'lv-parcial.idx')));
const tA = texto(pdfPath('lv-parcial'));
nota('T4_paginas', tA.length - 1);

// --- T6: equivalencia con cap_actual -----------------------------------------------------------
// Rasterizado y diff de imágenes. Con el texto de pdftotext no se puede: reordena las líneas de las
// ecuaciones y de las figuras sin que cambie el contenido (31 de 48 páginas "distintas" a pesar de
// tener el mismo layout).
const cmp = spawnSync('python', ['-I', path.join(import.meta.dirname, 'comparar-raster.py'),
  pdfPath('lv-parcial'), refPdf, path.join(work, 'raster'), '60'], { encoding: 'utf8' });
nota('T6_raster_vs_cap_actual', { codigo: cmp.status, resumen: cmp.stdout.trim().split(/\r?\n/).slice(0, 4) });

// --- T2: estilos del \input de la raíz (espacio + tilde) -----------------------------------------
for (const style of ['bare', 'ext']) {
  writeIfChanged(drvPath(`s4${style}`), renderDriver({ ...base, perfil: `s4${style}`, rootStyle: style }));
  const r = latexmk(`.lv/drivers/lv-s4${style}.tex`);
  nota(`T2_input_${style}`, { codigo: r.code, s: +r.s.toFixed(1), pdf: fs.existsSync(pdfPath(`lv-s4${style}`)) });
}

// --- T5: variable desde el driver contra el \def incondicional de structure.tex ---------------------
writeIfChanged(drvPath('s4var'), renderDriver({ ...base, perfil: 's4var', vars: { OpcionPie: 'ninguno' } }));
latexmk('.lv/drivers/lv-s4var.tex');
// El pie "Extracto Preliminar" sale en casi todas las páginas menos en la primera de cada capítulo,
// así que se cuentan en todo el PDF. Si el driver ganara, s4var no tendría ninguno.
const cuenta = (pags) => pags.join('').split('Extracto Preliminar').length - 1;
const conPie = cuenta(texto(pdfPath('lv-parcial'))), conVar = cuenta(texto(pdfPath('lv-s4var')));
nota('T5_pies_sin_variable_y_con_ninguno', [conPie, conVar]);
nota('T5_OpcionPie_ninguno_gana', conVar === 0);

// --- T7: ancho del log con y sin -max-print-line ---------------------------------------------------------
const anchoLog = (extra) => {
  const job = 'lv-s4ancho';
  fs.copyFileSync(drvPath('parcial'), drvPath(job));
  run('pdflatex', ['-interaction=nonstopmode', '-file-line-error', '-jobname', job, ...extra, `.lv/drivers/lv-${job}.tex`]);
  return Math.max(...leer(path.join(P, `${job}.log`)).split(/\r?\n/).map((l) => l.length));
};
nota('T7_ancho_max_log_sin_opcion', anchoLog([]));
nota('T7_ancho_max_log_con_opcion', anchoLog(['-max-print-line=10000']));

// --- T8: externalización con el driver fuera del cwd -----------------------------------------------------
// pgf lanza cada figura faltante como: pdflatex -jobname <fig> "\def\tikzexternalrealjob{<job>}\input{<job>}".
// Con el driver en .lv/drivers/ y cwd = raíz, ese \input{lv-ext} no encuentra el archivo.
writeIfChanged(drvPath('ext'), renderDriver({ ...base, perfil: 'ext' }));
const figs = [`${SELLO}-desnorm-0.pdf`].filter((f) => fs.existsSync(path.join(P, 'figuras-cache', f)));
nota('T8_figura_borrada_para_forzar', figs);
for (const f of figs) fs.rmSync(path.join(P, 'figuras-cache', f));
const e = latexmk('.lv/drivers/lv-ext.tex');
nota('T8_ext_driver_fuera_del_cwd', {
  codigo: e.code, s: +e.s.toFixed(1),
  figura_cocinada: figs.every((f) => fs.existsSync(path.join(P, 'figuras-cache', f))),
  error: (e.out.match(/File `[^']*lv-ext[^']*' not found[^\n]*|! I can't find file[^\n]*|Emergency stop[^\n]*/) ?? [''])[0],
});

fs.writeFileSync(path.join(work, 'resultados.json'), JSON.stringify(res, null, 2));
console.log('\nresultados en', path.join(work, 'resultados.json'));
