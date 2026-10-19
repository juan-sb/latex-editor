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

- `cargo test -p lv-core`: unitarios del core (EOL y BOM, rutas, proyecto, configuración, grafo de inclusión, auxiliares, runner del build y sesión con un latexmk falso de PowerShell). **Es `-p lv-core` y no `--workspace`**: `src-tauri` necesita `dist/` para compilar.
- `cargo test -p lv-core --features tex`: integración con TeX real (latexmk, pdflatex, biber), incluida la sesión alternando perfiles; se corre local.
- `npm test` (Vitest) y `npm run typecheck`: el frontend. Los tests no importan `pdfjs-dist` (la lógica del visor va aparte).
- `npx tauri build --no-bundle`: compila la app (`target\release\lv-app.exe`) y corre `npm run build` antes. `npx tauri dev` para desarrollar.
- `cargo run -p lv-core --example build -- <carpeta> [perfil] [--root <raíz.tex>] [--parts "A,B"]`: compila con el mismo motor que la app (perfiles, partes, sembrado, reparación), sin interfaz.
- `scripts/aceptacion-f1.ps1 -Proyecto libro-tc|libro-include|articulo-simple`: el smoke de F1 dentro de la app real (`LV_SMOKE=1`).
- `scripts/aceptacion-f2.ps1`: el smoke de F2 sobre una copia tibia del libro (`LV_SMOKE=f2`, unos 6 minutos): perfiles, sembrado, guardar a PDF visible, cola, cancelar, recarga sin parpadeo, publicar. Necesita el cache de figuras tibio de `fixtures\libro-tc`.
- `scripts/aceptacion-f3.ps1`: el smoke de F3 sobre `fixtures/errores` (`LV_SMOKE=f3`, medio minuto): problemas, gutter, F8, panel.
- `scripts/aceptacion-f4.ps1`: el smoke de F4, SyncTeX sobre el libro (`LV_SMOKE=f4`, ~1 minuto: compila el rápido y mide 50 saltos). Necesita el cache de figuras tibio.
- `cargo test -p lv-core --features tex --test synctex_oraculo`: el parser de SyncTeX contra el CLI `synctex`, sobre `fixtures/sync`.
- `cargo run -p lv-core --example problemas -- <raíz> <log|blg|ilg>`: lo que el parser saca de un log, para mirar uno nuevo antes de escribir su prueba. Los logs de `fixtures/logs/` se generan con `--example build` sobre `fixtures/errores` (copiado a `spikes/work`).
- `scripts/compilar-fixtures.ps1`: compila los fixtures con latexmk a secas.
- Variables de entorno de la app: `LV_OPEN` (carpeta a abrir), `LV_ROOT` (raíz del documento), `LV_SMOKE` (`1` o `f2`), `LV_SMOKE_FILE`, `LV_SMOKE_OUT`, `LV_LATEXMK` (otro ejecutable en lugar de latexmk).

## Estructura

```
plan.md        diseño y fases
docs/          benchmarks.md, spikes/Sx.md, decisiones
fixtures/      proyectos chicos de prueba; libro-tc/ es la copia del libro (ignorada); configs/ trae el latexviewer.json del libro
scripts/       copiar-libro, bench-base, compilar-fixtures, aceptacion-f1, aceptacion-f2, bom-ps1
spikes/        código de los spikes de F0, de referencia (work/ ignorada)
crates/lv-core core en Rust (sin Tauri): fsio, project, config (latexviewer.json y estado), graph (inclusión y partes),
               auxiliares (aislamiento de los .aux), build (driver, latexmk, streaming), procs (Job Objects), session (cola y motor),
               logparse (log de TeX, biber y makeindex a problemas), synctex (parser del .synctex.gz y las dos consultas)
               En el frontend, `src/sync/` tiene la lógica pura de SyncTeX (texto plano, búsqueda de palabras, los dos saltos).
src-tauri/     capa fina de Tauri (comandos y eventos)
src/           frontend: backend/ (interfaz y única implementación Tauri), store/, editor/, pdf/, panels/
inspo/         referencia, intocable, no se versiona
```

## Cosas del build que ya costaron un fallo

- **latexmk corre makeindex y las reglas del proyecto desde el directorio de salida** (`.lv/build/<perfil>/`), con nombres sueltos. Un `$makeindex` con `-s StyleInd.ist` relativo a la raíz falla ("Index style file ... not found") salvo que `.lv/latexmkrc` defina `INDEXSTYLE` con la raíz, que es lo que hace.
- **Dentro de latexmk el `PATH` queda reducido al `bin` de MiKTeX**: un rc no puede lanzar `powershell` ni `tasklist` por nombre.
- `-max-print-line` va por `-latexoption=`; redefinir `$pdflatex` pisaría los envoltorios del `latexmkrc` del proyecto.
- El log del build se emite en **fragmentos de texto**, no en líneas (pdflatex escribe `[12] [13]` sin saltos), y se lee por bloques de bytes con decodificación UTF-8 que no parte caracteres.
- **Limpiar o sembrar auxiliares va DENTRO de `Builder::start_with`** (el parámetro `antes`), después de comprobar que no hay otro build: hacerlo antes borraría los `.aux` de un build que está corriendo.
- **El marcador `.lv/build/<perfil>/.sospechoso` se pone antes de compilar y se saca sólo con un build ok**: así sobrevive a un cierre brusco. Un perfil sospechoso no se siembra ni se publica.
- **`\include` abre los `.tex` de las partes excluidas** para comprobar que existen: el `.fls` no sirve para saber qué compiló un parcial (se mira la cantidad de páginas del log).
- Las pasadas y el `.aux` truncado se detectan sobre el stream (`Contador`), con las agujas partidas entre fragmentos; no se guarda el log entero (el del libro pesa megas).

## Trampas de las herramientas de esta máquina

- **No escribir código con backslashes a través de un heredoc de bash** (ni siquiera Rust o TS: `\\` llega como `\`). Siempre Write/Edit. Es lo mismo que pasa con el LaTeX.
- **Nada de archivos o módulos llamados `aux`, `con`, `nul`, `prn`, `com1`...** (nombres reservados de Windows): el archivo se crea y compila, pero `git add` falla y no se puede ni borrar con las herramientas comunes (hay que usar la ruta `\\?\` por .NET). Por eso el módulo de aislamiento de auxiliares es `auxiliares`.
- **No sacar capturas de pantalla de la ventana ni mover el mouse para probar la interfaz**: la captura toma lo que esté encima (una vez salió otro programa de la persona) y el mouse pisa lo que esté haciendo. La interfaz se prueba con los smokes dentro de la app.
- `cargo` y `rustc` no están en el `PATH` de las herramientas: `$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH` antes de usar cargo en PowerShell.
- En un script `.ps1`, `"...$var: ..."` es una referencia a una unidad: va `${var}:`.

## Entorno de esta máquina

Ryzen 7 3700X (8 núcleos / 16 hilos), 16 GB, Windows 11. MiKTeX 26.5 (LaTeX 2026-06-01, pdfTeX 4.27), latexmk 4.88, Perl ActiveState 5.36, Node 20, Rust stable-msvc. Los scripts de este repo son PowerShell o Node; Git Bash está disponible pero no se usa para escribir LaTeX.
