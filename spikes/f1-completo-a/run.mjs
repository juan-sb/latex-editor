// Paso 0 de F1: el perfil `completo` del libro con el esquema A de S1, que en F0 no se había probado.
//
//   node spikes/f1-completo-a/run.mjs
//
// Copia el libro de inspo en frío a spikes/work/f1-completo/Proyecto, genera el driver y el .lv/latexmkrc como los
// va a generar `lv-core::build`, compila con la misma línea de comandos y revisa lo que el completo trae de más que
// el parcial y el rápido: biber, makeindex con StyleInd.ist (que usa %O/%D del rc del libro con otro $out_dir),
// `.aux` de capítulo en el directorio del perfil y referencias resueltas. Después hace un cambio chico con los `.aux`
// tibios. Todo lo que mide queda en spikes/work/f1-completo/resultados.json.
import fs from 'node:fs';
import path from 'node:path';
import { renderDriver, writeIfChanged } from '../s4-driver/gen-driver.mjs';
import * as L from '../s1-aux/lib.mjs';

const WORK = path.join(L.repo, 'spikes', 'work', 'f1-completo');
const P = path.join(WORK, 'Proyecto');
const OUT = path.join(P, '.lv', 'build', 'completo');
const res = {};
const nota = (k, v) => { res[k] = v; console.log(k.padEnd(28), typeof v === 'object' ? JSON.stringify(v) : v); };

const cp = L.run('powershell', ['-NoProfile', '-File', path.join(L.repo, 'scripts', 'copiar-libro.ps1'),
  '-Limpio', '-Destino', 'spikes\\work\\f1-completo\\Proyecto']);
if (cp.code !== 0) throw new Error('copiar-libro falló: ' + cp.out);

// Driver y rc como los va a generar lv-core: sin flags de perfil parcial, sin \includeonly.
writeIfChanged(path.join(P, '.lv', 'drivers', 'lv-completo.tex'),
  renderDriver({ perfil: 'completo', root: L.ROOT, parcial: false, flags: [], includeonly: null }));
// Mismo texto que `lv-core::build::render_latexmkrc`. La primera versión de este script no llevaba INDEXSTYLE y el
// completo falló: latexmk corre makeindex desde el directorio de salida y no encontraba StyleInd.ist (raíz).
writeIfChanged(path.join(P, '.lv', 'latexmkrc'), [
  '# LaTeX Viewer: auxiliares y PDF por perfil. Se lee DESPUÉS del latexmkrc del proyecto.',
  'use Cwd;',
  "my $p = $ENV{LV_PERFIL} or die 'falta LV_PERFIL';",
  "my $sep = ($^O eq 'MSWin32') ? ';' : ':';",
  '$out_dir = ".lv/build/$p";',
  '$aux_dir = ".lv/build/$p";',
  '$emulate_aux = 0;',
  '$ENV{TEXINPUTS} = ".lv/drivers$sep" . ($ENV{TEXINPUTS} // \'\');',
  "$ENV{INDEXSTYLE} = getcwd() . ($ENV{INDEXSTYLE} ? $sep . $ENV{INDEXSTYLE} : '');",
  '',
].join('\n'));

const args = ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error',
  '-latexoption=-max-print-line=10000', '-r', '.lv/latexmkrc', '.lv/drivers/lv-completo.tex'];
const build = (etiqueta) => {
  const r = L.run('latexmk', args, { cwd: P, env: { LV_PERFIL: 'completo' } });
  fs.writeFileSync(path.join(WORK, `latexmk-${etiqueta}.txt`), r.out);
  return r;
};

console.log('== completo en frío (5 a 6 minutos)…');
const frio = build('frio');
const pdf = path.join(OUT, 'lv-completo.pdf');
const log = path.join(OUT, 'lv-completo.log');
nota('frio', { codigo: frio.code, s: +frio.s.toFixed(1), pasadas: L.pasadas(frio.out) });
nota('latexoption_aceptado', !/Unrecognized option|Unknown option|-latexoption/i.test(frio.out.split('\n').filter((l) => /rror|nrecogni|nknown/.test(l)).join('\n')));
nota('pdf', fs.existsSync(pdf));
if (fs.existsSync(pdf)) {
  const t = L.run('pdftotext', ['-layout', pdf, '-']).out;
  nota('paginas', t.split('\f').length - 1);
  nota('signos_??_en_pdf', (t.match(/\?\?/g) ?? []).length);
}
const logTxt = L.leer(log);
nota('refs_sin_resolver_en_log', (logTxt.match(/LaTeX Warning: (Reference|Citation) `[^']*' on page \d+ undefined/g) ?? []).length);
nota('max_linea_log', Math.max(...logTxt.split(/\r?\n/).map((l) => l.length)));
nota('ind_generado', fs.existsSync(path.join(OUT, 'lv-completo.ind')));
nota('ind_usa_StyleInd', /StyleInd\.ist|makeindex/i.test(frio.out));
nota('biber_corrio', /biber/i.test(frio.out) && fs.existsSync(path.join(OUT, 'lv-completo.bbl')));
nota('aux_de_capitulo_en_outdir', fs.existsSync(path.join(OUT, 'Secciones')) ? fs.readdirSync(path.join(OUT, 'Secciones')).filter((f) => f.endsWith('.aux')).length : 0);
nota('aux_sueltos_en_raiz', [...L.archivos(P, ['.lv', 'figuras-cache', 'Pictures', 'Imagenes', 'Herramientas', 'Apuntes', 'Sources', '_Revisar', 'output_visualizations'])]
  .filter((f) => /\.(aux|toc|idx|ind|bbl|bcf|fls|fdb_latexmk|synctex\.gz)$/.test(f)).map((f) => path.relative(P, f)).slice(0, 8));
nota('synctex', fs.existsSync(path.join(OUT, 'lv-completo.synctex.gz')));
if (frio.code !== 0) { console.log(frio.out.split('\n').slice(-30).join('\n')); }

console.log('== sin cambios');
const igual = build('igual');
nota('sin_cambios', { codigo: igual.code, s: +igual.s.toFixed(1), pasadas: L.pasadas(igual.out) });

console.log('== cambio chico con auxiliares tibios');
const cap = path.join(P, 'Secciones', 'Desnormalización.tex');
const orig = fs.readFileSync(cap, 'utf8');
fs.writeFileSync(cap, orig.replace('Las secciones anteriores estudiaron', 'Las bench1 secciones anteriores estudiaron'));
const chico = build('chico');
nota('cambio_chico', { codigo: chico.code, s: +chico.s.toFixed(1), pasadas: L.pasadas(chico.out) });
fs.writeFileSync(cap, orig);

fs.writeFileSync(path.join(WORK, 'resultados.json'), JSON.stringify(res, null, 2));
console.log('listo:', path.join(WORK, 'resultados.json'));
