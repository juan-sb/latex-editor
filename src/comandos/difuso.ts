// Filtro difuso para los selectores (abrir archivo, paleta de comandos, ir a sección). Sin acentos ni mayúsculas; cada palabra de la
// consulta tiene que aparecer, como texto seguido o, si no, como letras salteadas en orden. Gana lo que coincide antes, al
// empezar una palabra y en un texto más corto.

export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function puntajeDeUna(t: string, q: string): number | null {
  const i = t.indexOf(q);
  if (i >= 0) {
    const inicioDePalabra = i === 0 || /[^a-z0-9]/.test(t[i - 1]);
    return 100 - Math.min(i, 60) + (inicioDePalabra ? 25 : 0);
  }
  // Letras salteadas, en orden ("abrc" en "abrir capítulo"): vale menos cuanto más separadas.
  let pos = -1;
  let huecos = 0;
  for (const c of q) {
    const j = t.indexOf(c, pos + 1);
    if (j < 0) return null;
    if (pos >= 0) huecos += j - pos - 1;
    pos = j;
  }
  return Math.max(1, 40 - huecos);
}

/** Qué tan bien coincide `texto` con `consulta` (mayor es mejor), o `null` si no coincide. Una consulta vacía coincide con todo. */
export function puntaje(texto: string, consulta: string): number | null {
  const palabras = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return 0;
  const t = normalizar(texto);
  let total = 0;
  for (const p of palabras) {
    const s = puntajeDeUna(t, p);
    if (s === null) return null;
    total += s;
  }
  return total - Math.min(t.length, 200) / 50;
}

/** Los elementos que coinciden, de mejor a peor (los empates quedan en su orden original). */
export function filtrarDifuso<T>(items: T[], consulta: string, texto: (x: T) => string, max = 200): T[] {
  if (!consulta.trim()) return items.slice(0, max);
  const puntuados: { x: T; s: number; i: number }[] = [];
  items.forEach((x, i) => {
    const s = puntaje(texto(x), consulta);
    if (s !== null) puntuados.push({ x, s, i });
  });
  return puntuados.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).map((p) => p.x);
}
