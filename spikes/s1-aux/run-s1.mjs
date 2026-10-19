// Spike S1: aislamiento de .aux por perfil y cache de figuras compartido (plan.md 5.4).
//
//   node spikes/s1-aux/run-s1.mjs --var A [--mit texinputs,syscall] [--hasta <etapa>]
//   node spikes/s1-aux/run-s1.mjs --var B
//
// Variante A: auxiliares y PDF de cada perfil en .lv/build/<perfil>/ (latexmk -outdir/-auxdir), drivers en
//             .lv/drivers/, sembrado de los .aux de las partes excluidas.
// Variante B: todo en la raíz como inspo, drivers en la raíz con jobnames distintos, y un intercambio de los
//             Secciones/**/*.aux de cada perfil por snapshots en .lv/aux/<perfil>/.
// --mit: mitigaciones para que la subcompilación de pgf encuentre el driver que no está en el cwd (sólo A):
//        texinputs = TEXINPUTS=.lv/drivers desde .lv/latexmkrc; syscall = system call de pgf con -include-directory.
//
// Corre sobre una copia tibia del libro (spikes/work/s1-<variante>/Proyecto). Etapas: r1 p1 estable alternar edit
// figura synctex kill. Resultados crudos en spikes/work/s1-<variante>/resultados.json.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderDriver, writeIfChanged } from '../s4-driver/gen-driver.mjs';
import * as L from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const VAR = flag('--var') ?? 'A';
const MIT = new Set((flag('--mit') ?? '').split(',').filter(Boolean));
const HASTA = flag('--hasta') ?? 'kill';
const NOMBRE = `s1-${VAR}${MIT.size ? '-' + [...MIT].join('+') : ''}`;
const ETAPAS = ['r1', 'p1', 'estable', 'alternar', 'edit', 'figura', 'figcambio', 'synctex', 'kill'];

const { P, SELLO, PDFDIR } = L.preparar(NOMBRE);
const WORK = path.dirname(P);
const PARTS = L.partes(P);
const RES = { variante: NOMBRE, sello: SELLO, partes: PARTS.length };
const tabla = [];
const j = (...p) => path.join(P, ...p);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nota = (k, v) => { RES[k] = v; console.log(k.padEnd(30), typeof v === 'object' ? JSON.stringify(v) : v); };

// --- drivers y latexmkrc -----------------------------------------------------------------------------------
const syscall = MIT.has('syscall')
  ? ['\\AddToHook{begindocument/before}{\\tikzset{external/system call={pdflatex -include-directory=.lv/drivers ' +
     '\\tikzexternalcheckshellescape -halt-on-error -interaction=batchmode -jobname "\\image" "\\texsource"}}}']
  : [];
const base = { root: L.ROOT, flags: ['CompilacionReducida', 'TikzExternalizar'], extraLines: syscall };
const PERFILES = {
  parcial: { ...base, perfil: 'parcial', parcial: true, includeonly: [L.PARTE_TRABAJO] },
  rapido: { ...base, perfil: 'rapido', parcial: false, includeonly: null },
};
const driverRel = (p) => (VAR === 'A' ? `.lv/drivers/lv-${p}.tex` : `lv-${p}.tex`);
for (const p of Object.keys(PERFILES)) writeIfChanged(j(driverRel(p)), renderDriver(PERFILES[p]));
if (VAR === 'A') {
  const rc = [
    '# LaTeX Viewer (spike S1): aislamiento de auxiliares por perfil. Se lee DESPUÉS del latexmkrc del proyecto.',
    "my $p = $ENV{LV_PERFIL} or die 'falta LV_PERFIL';",
    '$out_dir = ".lv/build/$p";',
    '$aux_dir = ".lv/build/$p";',
    '$emulate_aux = 0;',
    ...(MIT.has('texinputs') ? ["$ENV{TEXINPUTS} = '.lv/drivers;' . ($ENV{TEXINPUTS} // '');"] : []),
  ].join('\n') + '\n';
  writeIfChanged(j('.lv', 'latexmkrc'), rc);
}

const outDir = (p) => (VAR === 'A' ? j('.lv', 'build', p) : P);
const pdfDe = (p) => (VAR === 'A' ? j('.lv', 'build', p, `lv-${p}.pdf`) : path.join(PDFDIR, `lv-${p}.pdf`));
const logDe = (p) => path.join(outDir(p), `lv-${p}.log`);
const flsDe = (p) => path.join(outDir(p), `lv-${p}.fls`);

// --- sembrado (A) e intercambio (B) de .aux --------------------------------------------------------------------
const excluidas = PARTS.filter((x) => x !== L.PARTE_TRABAJO);
const auxDeParte = (dir, part) => path.join(dir, part + '.aux');
// Perfiles cuyo último build no terminó bien (falló o lo cortaron). Sus .aux pueden estar truncados.
const sospechoso = new Set();
function sembrar(desde, hasta, deQuien = 'rapido') {
  // Plan 5.4: se copia el .aux de cada parte excluida desde el build que lo tenga, si es más nuevo que el propio.
  // Se salta si el build de origen quedó sospechoso: sembrar de ahí propaga un .aux truncado (S1, etapa kill).
  if (sospechoso.has(deQuien)) return 0;
  let n = 0;
  for (const part of excluidas) {
    const s = auxDeParte(desde, part), d = auxDeParte(hasta, part);
    if (!fs.existsSync(s)) continue;
    if (!fs.existsSync(d) || fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs) if (L.copiarSiDifiere(s, d)) n++;
  }
  return n;
}
const snap = (p) => j('.lv', 'aux', p);
function auxEnRaiz() { return [...L.archivos(j('Secciones'))].filter((f) => f.endsWith('.aux')); }
function restaurarB(p) {
  const s = snap(p);
  if (p === 'parcial') sembrar(snap('rapido'), s, null);   // los snapshots sólo se guardan tras un build bueno
  const dueño = new Set();
  if (fs.existsSync(s)) for (const f of L.archivos(s)) {
    const rel = path.relative(s, f); dueño.add(rel);
    L.copiarSiDifiere(f, j(rel));
  }
  // Lo que el snapshot no tiene tampoco puede estar en la raíz: es de otro perfil.
  for (const f of auxEnRaiz()) if (!dueño.has(path.relative(P, f))) fs.rmSync(f);
}
function guardarB(p) {
  for (const f of auxEnRaiz()) L.copiarSiDifiere(f, path.join(snap(p), path.relative(P, f)));
}

/** Reparación de 5.5: se borran los auxiliares del perfil (no el PDF ni el cache de figuras). */
function reparar(p) {
  const tipos = /\.(aux|out|toc|lof|lot|bbl|bcf|blg|idx|ind|ilg|fdb_latexmk|fls|run\.xml|auxlock)$/;
  const dir = outDir(p);
  for (const f of [...L.archivos(dir, ['figuras-cache', '.lv', 'Pictures', 'Imagenes', 'Herramientas', 'Secciones'])]) {
    if (VAR === 'A' || path.basename(f).startsWith(`lv-${p}.`)) if (tipos.test(f)) fs.rmSync(f);
  }
  if (VAR === 'A') for (const f of L.archivos(path.join(dir, 'Secciones'))) fs.rmSync(f);
  if (VAR === 'B') { fs.rmSync(snap(p), { recursive: true, force: true }); for (const f of auxEnRaiz()) fs.rmSync(f); }
}

function argsLatexmk(p) {
  return ['-pdf', '-shell-escape', '-synctex=1', '-interaction=nonstopmode', '-file-line-error',
    ...(VAR === 'A' ? ['-r', '.lv/latexmkrc'] : []), driverRel(p)];
}
function antesDeBuild(p) {
  if (VAR === 'A') {
    // TeX no crea las subcarpetas de los \include dentro del aux dir: las crea la app antes.
    fs.mkdirSync(path.join(outDir(p), 'Secciones'), { recursive: true });
    if (p === 'parcial') return { sembradas: sembrar(j('.lv', 'build', 'rapido'), outDir('parcial')) };
    return {};
  }
  restaurarB(p);
  return {};
}
function build(p) {
  const pre = antesDeBuild(p);
  const f0 = L.fotoCache(P);
  const r = L.run('latexmk', argsLatexmk(p), { cwd: P, env: { LV_PERFIL: p } });
  // md5sync (A): con -output-directory pgf escribe el .md5 NUEVO de una figura en .lv/build/<perfil>/figuras-cache/,
  // y el otro perfil, que lee el de la raíz, lo ve viejo y recocina (medido: 23,8 s en vez de 8,8 s). Se mueven
  // al cache compartido después de cada build.
  if (VAR === 'A' && MIT.has('md5sync')) {
    const d = path.join(outDir(p), 'figuras-cache');
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md5')) { fs.copyFileSync(path.join(d, f), j('figuras-cache', f)); fs.rmSync(path.join(d, f)); }
    }
  }
  // El snapshot (B) sólo se guarda si el build salió bien: es la "última versión buena" del perfil.
  if (r.code === 0) { sospechoso.delete(p); if (VAR === 'B') guardarB(p); } else sospechoso.add(p);
  const cocinadas = L.cocinadas(f0, L.fotoCache(P));
  const log = L.leer(logDe(p));
  const err = (log.match(/^! [^\n]*|[^\n]*\.tex:\d+: [^\n]*/m) ?? [''])[0].slice(0, 160);
  return { perfil: p, codigo: r.code, s: +r.s.toFixed(1), pasadas: L.pasadas(r.out), cocinadas: cocinadas.length,
    ...pre, ...(r.code ? { error: err } : {}), _out: r.out, _cocinadas: cocinadas };
}
const resumen = ({ _out, _cocinadas, ...r }) => r;
function paso(etapa, r) {
  const x = resumen(r); tabla.push({ etapa, ...x });
  console.log(`  ${etapa.padEnd(16)} ${JSON.stringify(x)}`);
  return r;
}

// --- edición de prueba --------------------------------------------------------------------------------------------
const cap = j(L.PARTE_TRABAJO + '.tex');
const capOriginal = fs.readFileSync(cap);
const ancla = 'Las secciones anteriores estudiaron';
const editar = (n) => fs.writeFileSync(cap, capOriginal.toString('utf8').replace(ancla, `Las bench${n} secciones anteriores estudiaron`));
const restaurarCap = () => fs.writeFileSync(cap, capOriginal);

function fin() {
  restaurarCap();
  nota('tabla', tabla.length + ' pasos (ver resultados.json)');
  RES.pasos = tabla;
  fs.writeFileSync(path.join(WORK, 'resultados.json'), JSON.stringify(RES, null, 2));
  console.log('\nresultados en', path.join(WORK, 'resultados.json'));
  process.exit(0);
}
const alcanzo = (e) => { if (HASTA === e) fin(); };

try {
  console.log(`== ${NOMBRE}  (sello ${SELLO}, ${PARTS.length} partes)`);

  // r1: el rápido primero, con auxiliares limpios y cache de figuras tibio.
  const r1 = paso('r1 rapido', build('rapido'));
  nota('r1_refs', L.refsSinResolver(logDe('rapido'), pdfDe('rapido')));
  nota('r1_md5_en', L.dondeMd5(P));
  nota('r1_inputs_aux', [...new Set((L.leer(flsDe('rapido')).match(/^INPUT [^\n]*\.aux$/gm) ?? []).map((l) => l.slice(6).replace(/[^/\\]*$/, '')))]);
  if (r1.codigo) { console.log(r1._out.split('\n').slice(-25).join('\n')); }
  alcanzo('r1');

  // p1: el parcial con sembrado.
  const p1 = paso('p1 parcial', build('parcial'));
  nota('p1_refs', L.refsSinResolver(logDe('parcial'), pdfDe('parcial')));
  nota('p1_inputs_aux', [...new Set((L.leer(flsDe('parcial')).match(/^INPUT [^\n]*\.aux$/gm) ?? []).map((l) => l.slice(6).replace(/[^/\\]*$/, '')))]);
  if (p1.codigo) { console.log(p1._out.split('\n').slice(-25).join('\n')); }
  alcanzo('p1');

  // estable: nada cambió, ni pasadas.
  paso('estable P', build('parcial')); paso('estable R', build('rapido'));
  alcanzo('estable');

  // alternar: P R P R sin tocar nada. Objetivo: 0 pasadas.
  for (let i = 0; i < 2; i++) { paso(`alternar P${i + 1}`, build('parcial')); paso(`alternar R${i + 1}`, build('rapido')); }
  alcanzo('alternar');

  // edit: un cambio en la parte de trabajo, y cómo se propaga.
  editar(1);
  paso('edit P', build('parcial')); paso('edit R', build('rapido')); paso('edit P otra vez', build('parcial'));
  restaurarCap();
  paso('deshacer P', build('parcial')); paso('deshacer R', build('rapido'));
  alcanzo('edit');

  // figura: una figura sin cocinar, y si el otro perfil la usa sin recocinar.
  const fig = j('figuras-cache', `${SELLO}-desnorm-0.pdf`);
  fs.rmSync(fig, { force: true });
  // Borrar el PDF no basta: latexmk no ve ningún cambio y no hace pasada (0 pasadas, la figura no
  // se recocina). Se fuerza con una edición, como un guardado de verdad.
  editar(3);
  const fp = paso('figura P', build('parcial'));
  nota('figura_P_recocinada', fs.existsSync(fig));
  if (fp.codigo) console.log(fp._out.split('\n').filter((l) => /rror|not found|Emergency/.test(l)).slice(0, 6).join('\n'));
  const fr = paso('figura R', build('rapido'));
  nota('figura_R_cocinadas', fr._cocinadas);
  restaurarCap();
  paso('figura: deshacer P', build('parcial')); paso('figura: deshacer R', build('rapido'));
  alcanzo('figura');

  // figcambio: cambia el CÓDIGO de una figura (no sólo falta su PDF). Es el caso que decide si el .md5 es
  // compartido: si lo escribe cada perfil en su directorio, el otro ve un md5 viejo y recocina.
  fs.writeFileSync(cap, capOriginal.toString('utf8').replace('\\def\\xmax{5.0}', '\\def\\xmax{5.1}'));
  const md5Antes = L.dondeMd5(P);
  const cp = paso('figcambio P', build('parcial'));
  nota('figcambio_P_cocinadas', cp._cocinadas);
  const cr = paso('figcambio R', build('rapido'));
  nota('figcambio_R_cocinadas', cr._cocinadas);
  nota('figcambio_md5_en', { antes: md5Antes, despues: L.dondeMd5(P) });
  restaurarCap();
  paso('figcambio: deshacer P', build('parcial')); paso('figcambio: deshacer R', build('rapido'));
  alcanzo('figcambio');

  // synctex: ida y vuelta en 10 líneas de la parte de trabajo, sobre el PDF de cada perfil.
  const lineas = fs.readFileSync(cap, 'utf8').split(/\r?\n/).map((t, i) => ({ t, n: i + 1 }))
    .filter((x) => /^[A-Za-zÁÉÍÓÚ]/.test(x.t) && x.t.length > 150 && !x.t.includes('%'));
  const muestra = Array.from({ length: 10 }, (_, k) => lineas[Math.floor((k * lineas.length) / 10)]);
  for (const p of ['parcial', 'rapido']) {
    const pdf = pdfDe(p);
    const gz = pdf.replace(/\.pdf$/, '.synctex.gz');
    let ok = 0; const fallas = [];
    for (const { n } of muestra) {
      const v = L.run('synctex', ['view', '-i', `${n}:1:${cap}`, '-o', pdf]).out;
      const page = v.match(/Page:(\d+)/)?.[1], x = v.match(/x:([\d.]+)/)?.[1], y = v.match(/y:([\d.]+)/)?.[1];
      if (!page) { fallas.push({ n, v: v.split('\n').slice(0, 3).join(' | ').slice(0, 120) }); continue; }
      const e = L.run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`]).out;
      const inp = e.match(/Input:(.*)/)?.[1] ?? '', line = Number(e.match(/Line:(\d+)/)?.[1] ?? 0);
      if (/Desnormaliza/.test(inp) && Math.abs(line - n) <= 2) ok++; else fallas.push({ n, inp: inp.slice(0, 80), line });
    }
    nota(`synctex_${p}`, { ok_de_10: ok, fallas: fallas.slice(0, 3), inputs_en_gz: L.synctexInputs(gz).filter((l) => /Desnormaliza|libro_cuerpo|lv-/.test(l)).slice(0, 4) });
  }
  alcanzo('synctex');

  // kill: se corta un build del rápido a mitad y se mira si al parcial le pasa algo.
  editar(2);
  antesDeBuild('rapido');
  const ch = spawn('latexmk', argsLatexmk('rapido'), { cwd: P, env: { ...process.env, LV_PERFIL: 'rapido' }, stdio: 'ignore' });
  await dormir(4000);
  spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F']);
  await dormir(1500);
  sospechoso.add('rapido');   // cancelar marca los auxiliares del perfil como sospechosos (plan 5.6)
  paso('tras kill: P', build('parcial'));
  const kr = paso('tras kill: R', build('rapido'));
  if (kr.codigo) nota('kill_R_error', kr._out.split('\n').filter((l) => /^!|\.tex:\d+:|File ended/.test(l)).slice(0, 3));
  restaurarCap();
  paso('restaurado P', build('parcial'));
  let rr = paso('restaurado R', build('rapido'));
  if (rr.codigo) {
    // Plan 5.5: se borran los auxiliares del perfil y se reintenta una sola vez.
    reparar('rapido');
    rr = paso('reparado R', build('rapido'));
  }
  nota('reparado_R_ok', rr.codigo === 0);
} finally {
  restaurarCap();
}
fin();
