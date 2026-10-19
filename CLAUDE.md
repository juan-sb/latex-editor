# LaTeX Viewer 2: guía de trabajo

App de escritorio (Tauri 2 + React + CodeMirror 6 + PDF.js, core en Rust) para editar y compilar proyectos LaTeX grandes. La fuente de verdad del diseño es `plan.md`: leerlo entero antes de tocar nada. Las decisiones marcadas **[decidido]** no se reabren sin preguntar; las marcadas **[spike]** se validan con código y medición, y el resultado va a `docs/spikes/Sx.md`.

El caso de prueba y la vara de rendimiento es el libro de `inspo/Proyecto`. Windows + MiKTeX es el entorno real; TeX Live / Linux no se rompen sin necesidad.

## Convenciones

- Identificadores en inglés; comentarios, docs y textos de la UI en español.
- Todo archivo que genere la app: UTF-8 sin BOM. **Nunca escribir LaTeX a través del shell** (los backslashes se rompen: un `printf '\begin'` mete un backspace). Siempre por código (`fs.writeFileSync`, Rust) o por Edit/Write.
- Excepción: los `.ps1` de este repo llevan BOM UTF-8. Windows PowerShell 5.1 (el único que hay acá) lee como ANSI un script sin BOM y rompe los acentos de los mensajes; los scripts de inspo hacen lo mismo. Después de crear o editar un `.ps1` con Write/Edit hay que reponer el BOM (`scripts/bom-ps1.ps1`).
- Los `.tex` del libro son UTF-8 sin BOM y CRLF; el editor y los generadores preservan EOL y BOM de cada archivo.
- Los comentarios explican el porqué cuando la solución no es la obvia, como hace el libro: "se probó X y pasaba Y". Es lo que evita que alguien la deshaga.
- Toda optimización se justifica con una medición en `docs/benchmarks.md` (antes y después, misma máquina).
- Rutas del protocolo y del estado: siempre relativas a la raíz del proyecto.
- El frontend no lanza procesos ni toca el disco: todo pasa por la interfaz `Backend` de TS. `lv-core` no depende de Tauri.

## Cosas que se preguntan antes (a Juan)

- Cambiar el stack.
- Tocar algo dentro de `inspo/` (no se modifica nunca; tests y benchmarks corren sobre la copia en `fixtures/libro-tc/`, que arma `scripts/copiar-libro.ps1`).
- Borrar cualquier cosa del libro.
- Si falta algo instalado (Perl para latexmk, Rust, Node, una versión de MiKTeX), se avisa en vez de buscarle la vuelta.

## Cerrar una fase

Al terminar cada fase, antes de pasar a la siguiente:

1. Tests verdes.
2. Checkboxes de `plan.md` tildados.
3. Benchmarks anotados en `docs/benchmarks.md` (cuando aplica).
4. Un commit.

Si un spike o la implementación contradicen el plan, se actualiza `plan.md` y se avisa. No se resuelve en silencio.

## Tests

- Unitarios en `lv-core`: grafo, drivers, parser de log, parser de SyncTeX, sello, figlist.
- Unitarios de frontend con Vitest: comandos de formato, normalización de texto para el sync.
- Integración con TeX real, aparte: `cargo test --features tex` (se corre local).

## Estructura

```
plan.md        diseño y fases
docs/          benchmarks.md, spikes/Sx.md, decisiones
fixtures/      proyectos chicos de prueba; libro-tc/ es la copia del libro (ignorada)
scripts/       copiar-libro, bench, compilar-fixtures
spikes/        código de los spikes de F0, de referencia
crates/lv-core core en Rust
src-tauri/     capa fina de Tauri
src/           frontend
inspo/         referencia, intocable, no se versiona
```

## Entorno de esta máquina

Ryzen 7 3700X (8 núcleos / 16 hilos), 16 GB, Windows 11. MiKTeX 26.5 (LaTeX 2026-06-01, pdfTeX 4.27), latexmk 4.88, Perl ActiveState 5.36, Node 20, Rust stable-msvc. Los scripts de este repo son PowerShell o Node; Git Bash está disponible pero no se usa para escribir LaTeX.
