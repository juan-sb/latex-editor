# LaTeX Viewer 2: guía de trabajo

App de escritorio (Tauri 2 + React + CodeMirror 6 + PDF.js, core en Rust) para editar y compilar proyectos LaTeX grandes. La fuente de verdad del diseño es `plan.md`: leerlo entero antes de tocar nada. Las decisiones marcadas **[decidido]** no se reabren sin preguntar; las marcadas **[spike]** se validan con código y medición, y el resultado va a `docs/spikes/Sx.md`.

El caso de prueba y la vara de rendimiento es el libro de `inspo/Proyecto`. Windows + MiKTeX es el entorno real; TeX Live / Linux no se rompen sin necesidad.

## Convenciones

- Identificadores en inglés; comentarios, docs y textos de la UI en español.
- Todo archivo que genere la app: UTF-8 sin BOM. **Nunca escribir LaTeX a través del shell** (los backslashes se rompen: un `printf '\begin'` mete un backspace). Siempre por código (`fs.writeFileSync`, Rust) o por Edit/Write.
- Excepción: los `.ps1` de este repo llevan BOM UTF-8. Windows PowerShell 5.1 (el único que hay acá) lee como ANSI un script sin BOM y rompe los acentos de los mensajes; los scripts de inspo hacen lo mismo. Después de crear o editar un `.ps1` con Write/Edit hay que reponer el BOM (`scripts/bom-ps1.ps1`).
- El editor y los generadores preservan el EOL y el BOM que tenga cada archivo, byte a byte. No se asume CRLF: el libro de este snapshot es LF puro y sin BOM (8 archivos sin salto final), aunque el `CLAUDE.md` del libro diga CRLF. El CRLF se prueba con `fixtures/libro-include` (que `.gitattributes` guarda sin conversión) y con casos sintéticos.
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

## Tests y comandos

- `cargo test -p lv-core`: unitarios del core (EOL y BOM, rutas, proyecto, runner del build con un latexmk falso). **Es `-p lv-core` y no `--workspace`**: `src-tauri` necesita `dist/` para compilar.
- `cargo test -p lv-core --features tex`: integración con TeX real (latexmk, pdflatex, biber); se corre local.
- `npm test` (Vitest) y `npm run typecheck`: el frontend. Los tests no importan `pdfjs-dist` (la lógica del visor va aparte).
- `npx tauri build --no-bundle`: compila la app (`target\release\lv-app.exe`) y corre `npm run build` antes. `npx tauri dev` para desarrollar.
- `cargo run -p lv-core --example build -- <carpeta> <raíz.tex>`: compila un proyecto con el perfil completo, sin interfaz.
- `scripts/aceptacion-f1.ps1 -Proyecto libro-tc|libro-include|articulo-simple`: el smoke de aceptación dentro de la app real (`LV_SMOKE=1`).
- `scripts/compilar-fixtures.ps1`: compila los fixtures con latexmk a secas.
- Variables de entorno de la app: `LV_OPEN` (carpeta a abrir), `LV_ROOT` (raíz del documento), `LV_SMOKE`, `LV_SMOKE_FILE`, `LV_SMOKE_OUT`, `LV_LATEXMK` (otro ejecutable en lugar de latexmk).

## Estructura

```
plan.md        diseño y fases
docs/          benchmarks.md, spikes/Sx.md, decisiones
fixtures/      proyectos chicos de prueba; libro-tc/ es la copia del libro (ignorada)
scripts/       copiar-libro, bench-base, compilar-fixtures, aceptacion-f1, bom-ps1
spikes/        código de los spikes de F0, de referencia (work/ ignorada)
crates/lv-core core en Rust: fsio, project, build (sin Tauri)
src-tauri/     capa fina de Tauri (comandos y eventos)
src/           frontend: backend/ (interfaz y única implementación Tauri), store/, editor/, pdf/, panels/
inspo/         referencia, intocable, no se versiona
```

## Cosas del build que ya costaron un fallo

- **latexmk corre makeindex y las reglas del proyecto desde el directorio de salida** (`.lv/build/<perfil>/`), con nombres sueltos. Un `$makeindex` con `-s StyleInd.ist` relativo a la raíz falla ("Index style file ... not found") salvo que `.lv/latexmkrc` defina `INDEXSTYLE` con la raíz, que es lo que hace.
- **Dentro de latexmk el `PATH` queda reducido al `bin` de MiKTeX**: un rc no puede lanzar `powershell` ni `tasklist` por nombre.
- `-max-print-line` va por `-latexoption=`; redefinir `$pdflatex` pisaría los envoltorios del `latexmkrc` del proyecto.
- El log del build se emite en **fragmentos de texto**, no en líneas (pdflatex escribe `[12] [13]` sin saltos), y se lee por bloques de bytes con decodificación UTF-8 que no parte caracteres.

## Entorno de esta máquina

Ryzen 7 3700X (8 núcleos / 16 hilos), 16 GB, Windows 11. MiKTeX 26.5 (LaTeX 2026-06-01, pdfTeX 4.27), latexmk 4.88, Perl ActiveState 5.36, Node 20, Rust stable-msvc. Los scripts de este repo son PowerShell o Node; Git Bash está disponible pero no se usa para escribir LaTeX.
