// Genera las consultas forward de S2: líneas de párrafos de los capítulos del libro, al azar y con semilla fija.
//
//   node spikes/s2-synctex/gen-queries.mjs <synctex.gz> <salida.tsv> [cantidad]
//
// Se eligen sólo archivos que están en el SyncTeX (los que entraron al PDF) y líneas de texto de más de 120
// caracteres que no empiezan con % ni con \, que es como está escrito el libro (un párrafo por línea).
import fs from 'node:fs';
import zlib from 'node:zlib';

const [gz, salida, cant = '50'] = process.argv.slice(2);
const N = Number(cant);

// mulberry32: semilla fija, así las 50 consultas son las mismas en cada corrida.
let s = 42;
const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const raw = zlib.gunzipSync(fs.readFileSync(gz));
// Los "Input:" también aparecen en medio del contenido (TeX declara cada archivo al abrirlo): se lee todo.
const archivos = [...raw.toString('utf8').matchAll(/^Input:\d+:(.*)$/gm)].map((m) => m[1].trim())
  .filter((p) => /\\Secciones\\[^\\]+\.tex$/i.test(p) && fs.existsSync(p));

const candidatas = [];
for (const f of archivos) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((t, i) => {
    if (t.length > 120 && !/^\s*[%\\]/.test(t)) candidatas.push([f, i + 1]);
  });
}
const elegidas = [];
const usadas = new Set();
while (elegidas.length < Math.min(N, candidatas.length)) {
  const k = Math.floor(rnd() * candidatas.length);
  if (!usadas.has(k)) { usadas.add(k); elegidas.push(candidatas[k]); }
}
fs.writeFileSync(salida, elegidas.map(([f, l]) => `F\t${f}\t${l}`).join('\n') + '\n', 'utf8');
console.log(`${archivos.length} archivos de Secciones en el SyncTeX, ${candidatas.length} líneas candidatas, ${elegidas.length} elegidas -> ${salida}`);
