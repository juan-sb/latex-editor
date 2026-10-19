// Reproduce en segundos el fallo del paso 0 de F1: con el esquema A latexmk corre makeindex DESDE el directorio de
// salida, y un `$makeindex = 'makeindex -s StyleInd.ist ...'` del proyecto (como el del libro) no encuentra el estilo.
//
//   node spikes/f1-completo-a/idx-fixture.mjs
//
// Usa fixtures/biblio-indice (biblatex + biber + makeindex) con el StyleInd.ist del libro en la raíz y tres variantes
// del .lv/latexmkrc: sin corrección, con INDEXSTYLE apuntando a la raíz, y reescribiendo el `-s` del $makeindex a ruta
// absoluta. Biber entra en la misma prueba: ve si encuentra el .bib estando en otro directorio.
import fs from 'node:fs';
import path from 'node:path';
import { renderDriver, writeIfChanged } from '../s4-driver/gen-driver.mjs';
import * as L from '../s1-aux/lib.mjs';

const WORK = path.join(L.repo, 'spikes', 'work', 'f1-idx');
fs.rmSync(WORK, { recursive: true, force: true });
const ist = path.join(L.repo, 'fixtures', 'libro-tc', 'StyleInd.ist');
if (!fs.existsSync(ist)) throw new Error('falta fixtures/libro-tc/StyleInd.ist (scripts/copiar-libro.ps1)');

const BASE = [
  '# LaTeX Viewer: auxiliares y PDF por perfil. Se lee DESPUÉS del latexmkrc del proyecto.',
  "my $p = $ENV{LV_PERFIL} or die 'falta LV_PERFIL';",
  '$out_dir = ".lv/build/$p";',
  '$aux_dir = ".lv/build/$p";',
  '$emulate_aux = 0;',
  "$ENV{TEXINPUTS} = '.lv/drivers;' . ($ENV{TEXINPUTS} // '');",
];
const VARIANTES = {
  'v0-sin-correccion': [],
  'v1-INDEXSTYLE': ['use Cwd;', "$ENV{INDEXSTYLE} = getcwd() . ($ENV{INDEXSTYLE} ? ';' . $ENV{INDEXSTYLE} : '');"],
  'v2-ruta-absoluta': [
    'use Cwd;',
    '{ my $d = getcwd(); $makeindex =~ s{(-s\\s+)([^\\s/\\\\:"]+)}{$1"$d/$2"}g; }',
  ],
};

const resumen = {};
for (const [nombre, extra] of Object.entries(VARIANTES)) {
  const P = path.join(WORK, nombre);
  fs.cpSync(path.join(L.repo, 'fixtures', 'biblio-indice'), P, { recursive: true });
  for (const f of ['main.aux', 'main.log', 'main.pdf', 'main.idx', 'main.ind', 'main.bbl', 'main.bcf']) fs.rmSync(path.join(P, f), { force: true });
  fs.copyFileSync(ist, path.join(P, 'StyleInd.ist'));
  // El mismo $makeindex que el libro.
  fs.writeFileSync(path.join(P, 'latexmkrc'), "$makeindex = 'makeindex -s StyleInd.ist %O -o %D %S';\n");
  writeIfChanged(path.join(P, '.lv', 'drivers', 'lv-completo.tex'), renderDriver({ perfil: 'completo', root: 'main.tex', parcial: false }));
  writeIfChanged(path.join(P, '.lv', 'latexmkrc'), [...BASE, ...extra].join('\n') + '\n');
  const r = L.run('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error',
    '-latexoption=-max-print-line=10000', '-r', '.lv/latexmkrc', '.lv/drivers/lv-completo.tex'], { cwd: P, env: { LV_PERFIL: 'completo' } });
  const out = path.join(P, '.lv', 'build', 'completo');
  const pdf = path.join(out, 'lv-completo.pdf');
  const txt = fs.existsSync(pdf) ? L.run('pdftotext', ['-layout', pdf, '-']).out : '';
  resumen[nombre] = {
    codigo: r.code,
    ind: fs.existsSync(path.join(out, 'lv-completo.ind')),
    bbl: fs.existsSync(path.join(out, 'lv-completo.bbl')),
    pdf: fs.existsSync(pdf),
    signos_en_pdf: (txt.match(/\?\?/g) ?? []).length,
    errores: r.out.split('\n').filter((l) => /not found|rror|gave return code|Undefined|Missing/.test(l)).slice(0, 4),
    comando_makeindex: (r.out.match(/Running 'makeindex[^\n]*'/) ?? [''])[0],
  };
  console.log(nombre.padEnd(20), JSON.stringify(resumen[nombre]));
}
fs.writeFileSync(path.join(WORK, 'resultados.json'), JSON.stringify(resumen, null, 2));
