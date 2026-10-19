# LaTeX Viewer 2: plan de implementación

> Plan para Claude Code. Leerlo entero antes de arrancar.
> **[decidido]** = ya se charló con Juan, no reabrir sin preguntar.
> **[spike]** = validarlo con código y medición antes de construir encima. Cada spike deja su resultado en `docs/spikes/Sx.md` y, si cambia una decisión, se actualiza este plan.

---

## 0. Qué se construye

Una app de escritorio para editar y compilar proyectos LaTeX grandes, con interfaz a lo Overleaf (archivos | editor | PDF) y cuatro cosas que la separan de un editor común:

1. **Compilar sólo lo que importa.** Perfiles (partes elegidas, libro rápido, libro completo, exportación) que no se pisan entre sí. Es la idea de `cap_actual` / `libro_fast` del libro de inspo, generalizada a cualquier proyecto y sin scripts a mano.
2. **Sync fino código ↔ PDF.** SyncTeX con refinamiento por palabra. En el libro de prueba cada párrafo es una sola línea de hasta ~500 caracteres, así que saltar "a la línea" no alcanza: hay que caer en la palabra.
3. **Cache de figuras TikZ** con nombres estables, cocción en paralelo y disparo automático.
4. **Atajos de teclado** (Ctrl+B, Ctrl+I, etc.) y navegación de proyecto (`\ref` → `\label`, `\cite` → `.bib`, `\input` → archivo).

Decisiones **[decidido]**:

- App de escritorio local, un solo usuario. La colaboración es por git. Puede volverse colaborativa algún día, pero está lejos: no se construye nada para eso, sólo se evitan decisiones que lo cierren (sección 11).
- Genérica: sirve para cualquier proyecto LaTeX. El libro de `inspo/Proyecto` es el caso de prueba principal y la vara de rendimiento.
- Reemplaza el esquema actual del libro (VS Code + `Menu.bat` + `latexmkrc` + scripts `.ps1`). La última fase lo retira, después de comprobar paridad.
- Windows + MiKTeX primero, que es donde se usa. TeX Live / Linux no se rompen sin necesidad.

---

## 1. Antes de escribir código

- Leer en `inspo/Proyecto/`: `README.md` (secciones "AYUDA" y "Compilación"), `CLAUDE.md` sección 5, `latexmkrc`, `cap_actual.tex`, `libro_fast.tex`, `libro_cuerpo.tex`, el bloque de externalización al final de `structure.tex`, y en `Herramientas/`: `comun.ps1`, `compilar.ps1`, `synctex_pdf.ps1`, `cocinar_figuras.ps1`, `exportar_capitulo.ps1`. Cada decisión rara que hay ahí tiene una razón medida; la sección 2 las resume, pero el detalle está en esos archivos.
- **No modificar nada dentro de `inspo/`.** Tests y benchmarks corren sobre una copia: `scripts/copiar-libro` copia `inspo/Proyecto` a `fixtures/libro-tc/` (ignorada por git, pesa).
- `inspo/` no se versiona en este repo.
- Crear `CLAUDE.md` del repo en F0 con las convenciones de la sección 13.

---

## 2. Lo que enseña inspo (no deshacer sin querer)

| # | Problema en el libro | Cómo lo resolvió inspo | Cómo lo hace la app |
|---|---|---|---|
| 1 | Compilar todo en cada guardado tarda ~1 min (~160 `tikzpicture`, 18k líneas) | Raíces separadas: `cap_actual` con `\includeonly` (~3 s), `libro_fast` (~7 s), completo (~1 min) | Perfiles con drivers generados; cada perfil con su jobname y sus auxiliares (sec. 5) |
| 2 | TeX fija el nombre de salida antes de leer el `.tex`; `--jobname` con tildes se corrompe en Windows (Perl → pdflatex) | Un archivo raíz por modo, nombres ASCII sin espacios | Drivers generados `lv-<perfil>.tex`, siempre ASCII. Nunca `--jobname` |
| 3 | Renombrar el PDF después de compilar: latexmk nunca lo da por al día y hace una pasada de ~3 s en cada guardado | Se dejó el nombre de la raíz | El PDF de trabajo no se renombra jamás. "Publicar" es una **copia** a otra carpeta con el nombre lindo |
| 4 | `\include` escribe `Secciones/X.aux` sin jobname: las raíces se pisan (2 pasadas extra al alternar) y una corrida cortada deja un `.aux` truncado (`File ended while scanning use of \@newl@bel`) | `libro_fast` trae los capítulos por `\input` (`\CapitulosPorInput`) | Aislamiento de `.aux` por perfil + sembrado de los `.aux` de partes excluidas (sec. 5.4). Detección y reparación automática del `.aux` truncado |
| 5 | En la reducida, `\makeindex` provocaba 6 pasadas y 15 s; sin él, 1 pasada y 3 s | `\CompilacionReducida` definido **antes** de `\input{structure}`: omite portada, índice, bibliografía y `\makeindex` | El driver define flags por perfil antes de cargar la raíz; los nombres de las macros son configurables (el libro usa `\CompilacionReducida`) |
| 6 | Pasada de pdflatex de 5 s | Externalización TikZ en `figuras-cache/`: baja a 2 s | Cache de figuras, modo "project" o "app" (sec. 7) |
| 7 | El contador global de pgf: dos figuras nuevas en el cap. 1 recocinaron 101 de 108 (~4,5 min) | Nombre `<sello>-<slug>-<n>`, slug por archivo con `\FigurasDe{}` | Igual. En modo "app" el slug sale solo del archivo |
| 8 | Cambio de estilo: recocinar de a una tarda ~7 min, y cada Ctrl+S encima mataba la corrida (24 min de reloj medidos) | Sello = md5 de `estilo_figuras.tex`; cocción en paralelo automática si no hay figuras del sello o hay < 60 % de las del sello anterior (~45 s) | Igual, orquestado por la app, con progreso en la UI |
| 9 | El makefile que genera pgf no anda desde `cmd.exe` | `cocinar_figuras.ps1` lanza las subcompilaciones | La app lanza las subcompilaciones directo. Nunca `make`. (Con MiKTeX 26.5 el disparo automático desde el `latexmkrc` de inspo ni siquiera corre: `PATH` reducido, ver `docs/benchmarks.md`) |
| 10 | Externalizar en el libro completo rompe (`\includepdf` con tildes en la ruta, `.toc` a medio escribir) | El completo no usa cache | Externalización configurable por perfil; el perfil de entrega va sin cache, y el completo de revisión sólo consume el cache (`cacheOnly`, sec. 7) |
| 11 | `tikzpicture` con `remember picture, overlay` externalizados desaparecen | Sólo se externaliza dentro de `figure` | Default: sólo dentro de `figure` |
| 12 | El forward search de LaTeX Workshop se queda pegado a una raíz | `synctex_pdf.ps1` elige el PDF por **especificidad, no por fecha** | Misma regla (sec. 6.4) |
| 13 | Dos compilaciones a la vez se pisan los auxiliares | "No correr dos raíces a la vez", a mano | Un solo build activo por proyecto. Guardar durante un build lo deja pendiente, **no lo mata** (sec. 5.6) |
| 14 | No se sabía por qué una compilación tardaba | `registro-compilacion.txt`: INICIO, pasadas, figuras cocinadas, FIN; si faltaban `.aux`/`.fdb_latexmk`, si había otro pdflatex, si la anterior no terminó | Historial estructurado con lo mismo, visible en la UI (sec. 9) |
| 15 | pdflatex colgado | `tasklist \| findstr pdflatex` | Job Objects en Windows para matar el árbol entero; aviso de huérfanos al abrir |
| 16 | Exportar capítulos sueltos sin cambiar el de trabajo, con el número impreso (el libro arranca en el cap. 8) | `libro_export.tex` + script; número = posición + `\setcounter{chapter}` | Perfil de exportación aislado. El número se lee del `.aux` (más robusto que parsear el `\setcounter`) |
| 17 | "Compilar el capítulo del archivo abierto", aunque sea un `fig_*.tex` o un anexo | `Get-CapituloDe`: él mismo, o el capítulo que lo trae con `\input` | Grafo de inclusión del proyecto (sec. 4.3) |
| 18 | Saber qué se está compilando | Reescribir el nombre de la receta en `settings.json` | Barra superior siempre visible con perfil y partes |
| 19 | Opciones de esta máquina (qué compila Ctrl+S, pie de página) fuera de git | `opciones.tex` no versionado | `.lv/state.json` + variables del proyecto que el driver inyecta como macros (sec. 4.1) |
| 20 | Iterar sobre una sola figura | `\BancoDePruebas`, `Herramientas/preview/*.tex` | Vista previa de fragmento (sec. 8.2) |
| 21 | Los `.tex` son UTF-8 sin BOM; un BOM en un archivo que entra por `\input` se cuela como carácter. El `CLAUDE.md` del libro dice que son CRLF, pero **los 50 archivos de texto del snapshot de inspo son LF puro** (medido en F1; 8 sin salto final) | Convención + `UTF8SinBOM` en los scripts | El editor preserva el EOL y el BOM que tenga cada archivo, byte a byte; todo lo que genera la app es UTF-8 sin BOM |
| 22 | Cada párrafo es una línea larga | Convención | Soft wrap por defecto; sync por palabra |
| 23 | Overfull `\hbox` | `compilar.ps1` los cuenta | Panel de problemas, con salto a la línea |

---

## 3. Stack y arquitectura

### 3.1 Stack [decidido, salvo que un spike diga otra cosa]

- **Shell:** Tauri 2 (Rust). Liviano, multiventana (PDF en un segundo monitor), WebView2 en Windows.
- **Frontend:** React + TypeScript + Vite. Estado con Zustand. Paneles redimensionables (`react-resizable-panels` o similar). Estilos a criterio (CSS modules o Tailwind), sin librería de componentes pesada.
- **Editor:** CodeMirror 6 (lo mismo que usa Overleaf). Gramática LaTeX: evaluar `codemirror-lang-latex` contra `@codemirror/legacy-modes` (stex). Requisito mínimo del árbol: saber si el cursor está en modo matemático, dentro de qué entorno y dentro de qué comando.
- **PDF:** `pdfjs-dist` con su `PDFViewer` (render perezoso de páginas, capa de texto, find controller).
- **Core en Rust:** `tokio` (procesos), `notify` (watcher), `flate2` (synctex.gz), `regex` (búsqueda; F5 la hizo con el crate `regex` y un recorrido propio en lugar de `ignore` + `grep-searcher`: una dependencia menos y alcanza para un proyecto de LaTeX), `serde`, `md-5`, Job Objects en Windows.
- **Compilación:** `latexmk` (necesita Perl; en MiKTeX no viene solo) con engine configurable: pdflatex por defecto, xelatex y lualatex soportados.

### 3.2 Módulos

```
Frontend (webview)                          Core (Rust, crate lv-core)
┌───────────────────────────┐   invoke    ┌──────────────────────────────────┐
│ editor/  CM6, keymap,     │ ──────────▶ │ project/  config, grafo, índice  │
│          autocompletado   │             │ build/    drivers, cola, latexmk,│
│ pdf/     PDF.js, sync,    │ ◀────────── │           aux, log, historial    │
│          resaltado        │   events    │ figures/  sello, figlist, cocción│
│ panels/  archivos, partes,│             │ synctex/  parser + índice        │
│          esquema, buscar, │             │ search/   búsqueda en proyecto   │
│          problemas,       │             │ fsio/     watcher, IO con EOL/BOM│
│          historial        │             │ procs/    Job Objects, huérfanos │
└───────────────────────────┘             └──────────────────────────────────┘
```

Reglas:

- El frontend no lanza procesos ni toca el disco: todo pasa por comandos de Tauri, envueltos en una interfaz `Backend` de TS (un solo archivo con la implementación Tauri, nada de `invoke` desparramado).
- `lv-core` es una crate de biblioteca, testeable sin UI. `src-tauri` es una capa fina que la expone.
- Todas las rutas del protocolo y del estado son **relativas a la raíz del proyecto**.

### 3.3 Estructura del repo

```
latex-viewer-2/
├── plan.md
├── CLAUDE.md
├── docs/            spikes/, benchmarks.md, decisiones
├── inspo/           (no tocar, no se versiona)
├── fixtures/
│   ├── articulo-simple/
│   ├── libro-include/    \include en subcarpetas, nombres con tildes y espacios
│   ├── biblio-indice/    biber + makeindex
│   ├── tikz-figuras/     externalización, figuras con overlay fuera de figure
│   ├── xelatex/
│   └── libro-tc/         copia del libro (ignorada)
├── scripts/         copiar-libro, bench-base, compilar-fixtures, bom-ps1
├── spikes/          código de los spikes de F0 (s1-aux, s2-synctex, s3-pdfjs, s4-driver); work/ ignorada
├── crates/lv-core/
├── src-tauri/
└── src/
```

### 3.4 API core ↔ UI (borrador, ajustar al implementar)

Comandos: `open_project(path)` → vista del proyecto (raíz, configuración, estado, partes), `get_project()` (relee el disco), `set_root_file(rel)`, `read_file(rel)` → `{text (normalizado a \n), eol, bom, mixed, version}`, `write_file(rel, text, expected_version)` (restaura el EOL y el BOM **del archivo en disco**; `version` es el md5 del contenido; si el disco ya tiene otra, error `conflict`; no escribe si el contenido es idéntico), `set_state(patch)` (perfil activo, partes elegidas, variables, modo de auto-compilación; reemplaza a `set_selection` y `set_variable`), `save_config()`, `file_info(rel)` (a qué parte pertenece un archivo y si el perfil activo lo usa), `build(profile?)` → `started | queued`, `cancel_build()`, `publish(profile)`, `synctex_forward(rel, line, col)`, `synctex_inverse(profile, page, x, y)`, `search(query, opts)`, `replace(...)`, `bake_figures()`, `clean_figure_cache()`, `export_parts(parts[] | "all")`, `preview_fragment(rel, from, to)`, `doctor()`.

Eventos: `build:queued|started|log|finished|error` (en F2; `pass` y los demás vienen con sus fases), `figures:progress`, `fs:changed`, `index:updated`.

---

## 4. Modelo de proyecto

### 4.1 Archivos

| Archivo | Versionado | Qué tiene |
|---|---|---|
| `latexviewer.json` (raíz del proyecto) | sí | raíz, engine, partes, flags, perfiles, cache de figuras, variables, exportación |
| `.lv/` | no (la app lo agrega al `.gitignore`) | drivers generados, builds, estado, historial |
| `.lv/state.json` | no | perfil activo, partes elegidas, valores de variables, layout |
| settings y keybindings globales (dir de config de la app) | n/a | preferencias del usuario, atajos |

Sin `latexviewer.json`, la app lo infiere al abrir (la raíz es el `.tex` con `\documentclass` y `\begin{document}`; si hay varios, pregunta) y ofrece guardarlo. En el libro la inferencia por sí sola no alcanza: hay 5 archivos con `\documentclass` y el `\begin{document}` está en `libro_cuerpo.tex`, que entra por `\input`. **Desde F2** la raíz sale de `latexviewer.json`; si el usuario la cambia en esta máquina queda en `.lv/state.json` (`root`) y esa pisa a la del archivo. Sin `latexviewer.json` la app infiere la configuración (con partes: parcial, rápido y completo; sin partes: sólo completo) y **ofrece guardarla** desde el menú ⋯: nunca escribe un archivo del proyecto por su cuenta. Un `latexviewer.json` que no se puede leer se avisa y no se pisa: se trabaja con la configuración inferida. Es JSON estricto (sin comentarios: el ejemplo de abajo está comentado sólo para explicarlo), y los campos que esta versión no conoce (`figureCache`, `export`, los de fases futuras) se conservan al guardar. `.lv/` se agrega al `.gitignore` del proyecto sólo si ya es un repositorio.

Ejemplo para el libro:

```jsonc
{
  "root": "Funciones de Aproximación.tex",
  "engine": "pdflatex",
  "parts": { "commands": ["include", "Capitulo"] },   // qué comandos delimitan una parte
  "flags": {                                           // macros que define el driver según el perfil
    "partial":     ["CompilacionReducida"],
    "externalize": ["TikzExternalizar"],
    "figureList":  ["TikzListaYMake"]
  },
  "figureCache": {
    "mode": "project",                 // project | app | off (sec. 7)
    "dir": "figuras-cache",
    "stampFiles": ["estilo_figuras.tex"],
    "onlyInFigureEnv": true,
    "parallelJobs": "auto"
  },
  "variables": {
    "OpcionPie": { "label": "Pie de página", "choices": ["completo", "autor", "ninguno"], "default": "completo" }
  },
  "profiles": {
    "parcial":  { "label": "Partes elegidas", "partial": true,  "externalize": true,  "parts": "selection" },
    "rapido":   { "label": "Libro rápido",    "partial": true,  "externalize": true,  "parts": "all" },
    "completo": { "label": "Libro completo (revisión, con cache)", "externalize": true, "cacheOnly": true, "autoCompile": false },
    "entrega":  { "label": "Entrega (sin cache)", "partial": false, "externalize": false, "cleanBefore": true, "autoCompile": false },
    "export":   { "label": "Exportación",     "partial": true,  "externalize": true,  "parts": "one", "hidden": true }
  },
  "publish": { "dir": "../PDF", "names": { "entrega": "Funciones de Aproximación.pdf" } },
  "export":  { "dir": "../PDF/Capítulos", "pattern": "{num:02} - {name}.pdf" }
}
```

`"completo"` y `"entrega"` llevan `autoCompile: false` a propósito: si pudieran quedar elegidos para el guardado, cada Ctrl+S sería una corrida de medio minuto el de revisión y de cinco el de entrega (en inspo el completo no es receta).

**Dos perfiles para el libro entero (decidido tras S5, `docs/spikes/S5.md`).** `entrega` es el completo de siempre: sin cache, con `cleanBefore`, el único que se publica (`publish.names`) y el equivalente de la opción 3 del menú de inspo para la paridad de F9. Su PDF no depende del estado del cache y no carga las 806 fuentes incrustadas de las figuras (4,1 contra 5,7 MB). `completo` es para **revisar** el libro entero: con `cacheOnly` (sólo válido con `externalize`) compila sin `-shell-escape` y con `external/mode=graphics if exists`, sin `cleanBefore`, y la app cocina lo que falte antes de cada build. **No publica**: `publish` lo rechaza. La paginación y el texto coinciden con los de `entrega` (198 páginas, mismo multiconjunto de palabras por página), así que revisar con él es fiel. Un proyecto sin `latexviewer.json` sigue infiriendo un `completo` sin cache.

### 4.2 Drivers generados

Cada perfil compila un driver ASCII que la app escribe antes de cada build (sólo si cambió, para no tocar su mtime):

```tex
% .lv/drivers/lv-parcial.tex  (generado por LaTeX Viewer, no editar)
\def\lvPerfil{parcial}
\def\CompilacionReducida{}          % flags "partial"
\def\TikzExternalizar{}             % flags "externalize"
\def\OpcionPie{autor}               % variables
\AddToHook{begindocument/before}{\includeonly{Secciones/Desnormalización}}
\input{"Funciones de Aproximación"}
```

- Se compila con cwd = raíz del proyecto, así las rutas relativas de la raíz siguen resolviendo.
- `\includeonly` se inyecta por hook para no editar la raíz del usuario **[confirmado en S4]**: `begindocument/before` corre antes de que LaTeX prohíba `\includeonly`, y el PDF sale idéntico píxel a píxel al de `cap_actual` (`docs/spikes/S4.md`). La raíz entra por `\input{"nombre con espacios y tildes"}` sin problema.
- La app siempre define `\lvPerfil` y `\lvParcial` además de los alias configurados, para proyectos nuevos que quieran usarlos.
- Requiere LaTeX 2021-06 o posterior (hooks de archivo, `\CurrentFile`). El doctor lo verifica.

### 4.3 Grafo de inclusión e índice

Al abrir, y de forma incremental cuando cambia un archivo, el core indexa:

- **Grafo:** `\input`, `\include`, `\subfile`, `\import`, `\includegraphics`, `\bibliography`/`\addbibresource` y los comandos de `parts.commands` (como `\Capitulo`). Soporta llaves, comillas, espacios, tildes y extensión omitida. Ignora comentarios.
- **Partes:** las entradas de primer nivel hechas con `parts.commands`, en orden. Si las partes entran por `\input` y no por `\include`, `\includeonly` no sirve: el doctor lo avisa y ofrece pasarlas a `\include`.
- **Parte de un archivo:** él mismo si es una parte, o la parte que lo trae (recursivo). Es `Get-CapituloDe` generalizado.
- **Índice:** secciones (para el esquema), `\label`, `\ref`/`\eqref`/`\cref`/`\pageref`, claves de `.bib`, `\newcommand`/`\DeclareMathOperator`/`\newenvironment`/`\newtheorem`/`\newtcolorbox` definidos en el proyecto.
- Objetivo: el libro (18k líneas) indexado en menos de 1 s.

---

## 5. Motor de compilación

### 5.1 Invocación

```
latexmk -pdf (o -xelatex/-lualatex) -synctex=1 -interaction=nonstopmode -file-line-error
        [-shell-escape si el perfil externaliza] -r .lv/latexmkrc <dirs> .lv/drivers/lv-<perfil>.tex
```

- `-file-line-error` deja los errores como `./archivo.tex:123: mensaje`, mucho más fácil de parsear.
- Ancho de línea del log: `max_print_line=10000` (variable de entorno en TeX Live; en MiKTeX la opción `-max-print-line=10000`, verificada en S4). Sin eso el log corta a 79 columnas y rompe rutas. **Se pasa con `-latexoption=-max-print-line=10000`**, no redefiniendo `$pdflatex`: eso pisaría los envoltorios del `latexmkrc` del proyecto (el del libro mide cada pasada con `pdflatex_registrado`). Verificado en F1: latexmk 4.88 lo acepta y el log llega con líneas de hasta 1176 caracteres. **En TeX Live pdflatex no conoce esa opción** (avisa `unrecognized option '-max-print-line=10000'`, sigue y el log corta a 79; medido con TeX Live 2022 en la revisión previa a F6): la app pone además `max_print_line=10000` en el entorno de latexmk, que MiKTeX ignora.
- `.lv/latexmkrc` lo genera la app y se lee **después** del `latexmkrc` del proyecto, que sigue valiendo para reglas propias (makeindex con estilo, glossaries, nomencl). Lo de la app pisa `@default_files`, `$out_dir`/`$aux_dir` y lo que haga falta, y pone `TEXINPUTS` con `.lv/drivers` (5.4) e `INDEXSTYLE` con la raíz del proyecto: **latexmk corre makeindex desde el directorio de salida**, con nombres sueltos (`makeindex -s StyleInd.ist -o "lv-completo.ind" "lv-completo.idx"`), así que un `$makeindex` del proyecto con un estilo relativo a la raíz (como el del libro) falla con "Index style file StyleInd.ist not found" y el build sale con código 12. Es el perfil `completo`, que S1 no había probado: el parcial y el rápido no llevan índice. Con `INDEXSTYLE` el completo del libro compila bien con el esquema A (F1, paso 0: 346,8 s contra 338,5 s de la línea de base, 194 páginas, 0 referencias sin resolver, biber y makeindex funcionando). Cualquier otra regla del proyecto que nombre archivos relativos a la raíz puede fallar igual: el doctor tiene que avisar. Ojo: dentro de latexmk el `PATH` queda reducido al `bin` de MiKTeX (medido con MiKTeX 26.5, ver `docs/benchmarks.md`): el rc no puede lanzar por nombre programas que no estén ahí (`powershell`, `tasklist`), y falla en silencio. Lo que haga falta fuera de TeX lo lanza la app, no el rc.
- `-recorder` (default en latexmk) deja el `.fls`: es la lista exacta de archivos que usó cada perfil. Se usa para decidir si un guardado afecta al perfil activo.

### 5.2 Salidas

- Cada perfil compila en `.lv/build/<perfil>/` y su PDF se llama `lv-<perfil>.pdf`, con su `.synctex.gz` al lado.
- "Publicar" (opcional, por perfil) **copia** PDF y `.synctex.gz` a `publish.dir` con el nombre configurado. Nunca se renombra en el lugar (fila 3 de la tabla).
- El visor lee el PDF en memoria (bytes por comando), nunca deja un handle abierto: en Windows un PDF abierto bloquea la escritura de pdflatex.

### 5.3 Perfiles y qué compila el guardado

- El perfil activo se elige en la barra superior. Lo que compila Ctrl+S es siempre el perfil activo.
- **Partes elegidas:** checkboxes en el panel Partes y en el esquema. "Sólo esta" con un clic. Atajo para "compilar la parte del archivo abierto" (opción 1 del menú de inspo).
- **Guardar un archivo que el perfil activo no usa**: por defecto aviso no intrusivo con botón "Compilar esta parte". Configurable: avisar | cambiar la selección a esa parte | compilar igual. **Se decide con el grafo de inclusión** (`file_info`: el archivo es de una parte que la selección no incluye, y los archivos globales como el preámbulo afectan siempre; uno que no está en el grafo no dispara nada), **no con el `.fls`**: `\include` abre los `.tex` de las partes excluidas para comprobar que existen, así que el `.fls` de un parcial los lista aunque no se compilen (F2). El `.fls` queda para el historial de F8.
- **Modo de auto-compilación:** al guardar (default) | al dejar de tipear N ms (con autoguardado) | manual.
- Opción por perfil `draftImages`: `\PassOptionsToPackage{draft}{graphicx}` en el driver, para proyectos con muchas imágenes.

### 5.4 Aislamiento de `.aux` **[decidido por el spike S1: opción A]**

Objetivo: que alternar perfiles no cueste pasadas extra ni pueda dejar un `.aux` truncado a otro perfil, y que en el parcial las referencias a partes excluidas sigan resolviendo (con `\includeonly`, LaTeX las saca de los `.aux` de esas partes).

- **Opción A (elegida):** auxiliares y PDF por perfil (`$out_dir`/`$aux_dir` de latexmk en `.lv/build/<perfil>/`), drivers en `.lv/drivers/`. Medido con el libro real en `docs/spikes/S1.md`: cumple los cuatro criterios (referencias correctas en parcial y rápido, 0 pasadas al alternar, cache de figuras compartido, SyncTeX 10/10) con los mismos tiempos que inspo. Necesita **cinco ajustes**, sin los cuales falla (el quinto apareció en F1, al probar el perfil completo):
  1. **`TEXINPUTS` con `.lv/drivers`**, puesto desde `.lv/latexmkrc`. Sin eso la subcompilación de pgf (`\input{lv-<perfil>}` desde la raíz) no encuentra el driver y el build falla cuando hay que cocinar una figura.
  2. **Mover los `.md5` al cache compartido** después de cada build: con `-output-directory` pgf escribe el `.md5` nuevo en `.lv/build/<perfil>/figuras-cache/`, y el otro perfil, que lee el de `figuras-cache/`, recocina la misma figura (medido: 23,8 s en vez de 9,4 s).
  3. **Sembrado:** antes de un build parcial, para cada parte excluida se copia su `.aux` desde el build más reciente que lo tenga (rápido o completo) si es más nuevo que el propio, y sólo si el contenido difiere (así no se toca el mtime de lo que ya es igual y no se provocan pasadas). **No se siembra desde un build sospechoso** (falló o se canceló): propaga un `.aux` truncado. Como el rápido usa `\include` sin pisar a nadie, deja siempre `.aux` frescos de todas las partes.
  4. **Reparación de `.aux` truncado** (5.5), que cuesta un build en frío de `.aux` (36 a 39 s para el rápido).
  5. **`INDEXSTYLE` con la raíz del proyecto**, puesto desde `.lv/latexmkrc` (ver 5.1): latexmk corre makeindex desde el directorio de salida y un `$makeindex` del proyecto con un estilo relativo a la raíz no lo encuentra. Sin esto el perfil completo del libro falla con código 12.
- **Subcarpetas de `\include`:** la app las crea antes dentro del directorio de salida. MiKTeX las crea solo (medido), TeX Live no: se sigue creando por portabilidad.
- **Opción B (fallback, también cumple todo en S1):** todo en la raíz del proyecto como inspo, con drivers `lv-<perfil>.tex` en la raíz y jobnames distintos, y la app **intercambia** los `.aux` de partes: al terminar un build bueno los guarda en `.lv/aux/<perfil>/` y antes del siguiente build de ese perfil los restaura. No necesita `TEXINPUTS` ni mover `.md5`, pero deja los auxiliares y los drivers en la raíz.
- **TeX Live, probado a medias** (revisión previa a F6, `docs/revision-pre-F6.md`): con TeX Live 2022 y latexmk 4.76 sobre `fixtures/tikz-figuras`, `TEXINPUTS` y mover los `.md5` funcionan igual que en MiKTeX (0 subcompilaciones al pasar al otro perfil, 1 al cambiar una figura). **Pero TeX Live no crea `.lv/build/<perfil>/<cache>/`**: sin esa carpeta el primer build que externaliza falla con `I can't write on file '<cache>/....md5'` y `Emergency stop`. La app crea esa carpeta y `<cache>/` en la raíz antes de cada build (F6). El libro entero no se probó en TeX Live (esa instalación no trae biblatex); B sigue siendo el fallback.

### 5.5 `.aux` truncado

- Si el build falla con `File ended while scanning use of \@newl@bel` (o similar en un `.aux`; también sale como `\BKM@entry`, el `.out` de bookmark), la app borra (A) o restaura del snapshot (B) los `.aux` del perfil y reintenta una vez sola, avisando en el historial. Medido en S1: sin esa reparación el perfil cortado falla en todos los builds siguientes; con ella el rápido se recupera en un build en frío de `.aux` (36 a 39 s).

### 5.6 Cola y cancelación

- Un solo build activo por proyecto (los perfiles comparten el cache de figuras).
- Guardar durante un build lo marca **pendiente**; al terminar, corre una sola vez más (se coalescen los guardados). No se mata un build por un guardado.
- Cancelar es explícito (botón). Mata el árbol de procesos con Job Objects y marca los `.aux` del perfil como sospechosos (5.5): no se reutilizan ni se siembran desde ahí (5.4, S1) hasta que un build del perfil termine bien. **Implementado en F2:** `procs::Job` (con `KILL_ON_JOB_CLOSE`: si la app muere sin cancelar, el árbol muere con ella) más `taskkill /T` de respaldo, porque un hijo que latexmk lance antes de que el proceso entre en el Job podría escaparse. Cancelar también **descarta el pendiente**.
- **Cómo queda la cola (F2).** `Session::request_build` devuelve `started` o `queued`; los pedidos pendientes se coalescen (gana el último perfil) y el pendiente se vuelve a planear al arrancar (la selección o las variables pudieron cambiar). El marcador de sospechoso es el archivo `.lv/build/<perfil>/.sospechoso`: se crea **antes** de compilar y se borra sólo cuando el build sale ok, así sobrevive a un cierre brusco de la app. Limpiar y sembrar los auxiliares ocurre dentro del lanzamiento del build, después de comprobar que no hay otro corriendo (hacerlo antes borraría los `.aux` de un build en curso).
- Al abrir un proyecto: si hay `pdflatex`/`latexmk` huérfanos del proyecto, avisar y ofrecer matarlos.

### 5.7 Recarga del PDF

- Si el build terminó bien, recargar el PDF sin parpadeo: render en segundo plano y swap, conservando página, zoom y desplazamiento dentro de la página. **[decidido por S3]** Se hacen con **dos visores superpuestos**: el nuevo se arma y se pinta detrás, recibe la misma posición, y cuando sus páginas visibles terminaron de pintarse pasa adelante y el viejo se destruye. Medido con el libro (183 y 194 páginas): 0 cuadros en blanco y 0 de deriva en más de 130 recargas, ~220 a 230 ms hasta lo visible. El `setDocument` sobre el mismo visor deja 4 a 9 cuadros en blanco por recarga y a veces pierde la posición (salto de 59 páginas): descartado (`docs/spikes/S3.md`).
- **Alcance por fase:** el visor de F1 desarmaba el viejo por completo pero recargaba en el mismo contenedor (podía parpadear y perder la posición). **Desde F2** `src/pdf/viewer.ts` hace el swap de dos visores de S3: el nuevo se arma detrás (`z-index` 1), recibe página, escala y desplazamiento dentro de la página, y pasa al frente (`z-index` 2) cuando lo visible terminó de pintarse (con un tope de 20 s: si no termina, cambia igual); después se desarma el viejo. El smoke de F2 lo mide como S3 (`cargarMedido`): cuadros en blanco, deriva en páginas y px, y que quede un solo visor armado.
- **`ok` de un build** es "latexmk salió con 0 **y** existe el PDF"; aparte se informa `updated` (si ese build reescribió el PDF). Un build sin cambios sale con 0 sin tocar el PDF y no es un error; una salida distinta de 0 con PDF (latexmk deja el último en `nonstopmode` con errores) tampoco es ok. El visor sólo se recarga con un build ok y actualizado (o si todavía no mostraba ningún PDF).
- **El visor viejo se desarma por completo, y eso lleva test:** `abortSignal` en `PDFViewer` (abortada al destruirlo), `viewer.cleanup()`, canvas a tamaño cero, `await loadingTask.destroy()` y `await doc.destroy()`. Sin eso la memoria crece ~33 MB por recarga sin estabilizarse (1785 MB a las 40 recargas del rápido); con eso queda en ~0,7 GB. Criterio de aceptación: memoria estable a 40 recargas seguidas.
- Si falló o no hay PDF nuevo, queda el último bueno, con un borde o cartel de "desactualizado" y el panel de problemas abierto.
- Opción "detenerse en el primer error" (`-halt-on-error`), apagada por defecto.

### 5.8 Errores y advertencias

- Parser del log propio: pila de archivos por paréntesis, `archivo:línea:` de `-file-line-error`, `l.<n>`, `LaTeX Warning: Reference ... on input line N`, `Overfull/Underfull \hbox ... at lines a--b`, citas indefinidas, errores de biber y makeindex (sus propios logs).
- Marcas en el gutter, subrayado de la línea, panel de problemas con filtro, F8 / Shift+F8 para recorrerlos.
- Tests con logs reales guardados en `fixtures/logs/`.
- **Implementado en F3 (`lv-core::logparse`), con lo que enseñaron los logs reales:**
  - Los errores salen en dos formatos a la vez: `archivo:línea: mensaje` (`-file-line-error`) y `! mensaje` con `l.<n>` (un `! LaTeX Error: File ... not found` sale con `!` aunque lo demás no, y su línea la trae el `Emergency stop` que sigue).
  - Los archivos se abren con `(ruta` y se cierran con `)`, con espacios y tildes **sin comillas** (`(Secciones/Aproximación de Butterworth.tex`). Sólo cuentan los paréntesis de las líneas de traza: un bloque de mensaje (error, aviso, overfull) termina en la primera línea en blanco, pero los `Info` no terminan en una en blanco (los sigue un `)` que cierra un archivo): son la línea más sus continuaciones `(paquete)`. Un `(` abre archivo sólo si lo que sigue parece una ruta.
  - Un `Overfull ... at lines 2--1` (final antes que principio) es un párrafo que terminó al empezar otro archivo: se atribuye al archivo que se cerró recién y no al nuevo.
  - El log trae bytes que no son UTF-8 (palabras cortadas con guion en T1): se decodifica con reemplazo.
  - Los `Overfull`/`Underfull` son una severidad aparte (`badbox`) y el panel los trae apagados. Los `\vbox ... while \output is active` no tienen línea y no se atribuyen a ningún archivo.
  - Los avisos de resumen ("There were undefined references", "Please (re)run Biber", "Label(s) may have changed") no son problemas del documento y se descartan.
  - biber (`.blg`): `ERROR -`/`WARN -`, con el archivo de la última línea `Found BibTeX data source` y sin la ruta del temporal; makeindex (`.ilg`): `!!` y `## Warning`.
  - **latexmk no corre biber ni makeindex mientras haya errores de LaTeX** (sale con "Errors, so I did not complete making targets"): los problemas de la bibliografía y del índice aparecen recién cuando los de LaTeX están resueltos. No se pasa `-f` para forzarlo: haría pasadas de más con el documento roto.
  - El parser lee el `.log` de la **última pasada** del perfil (el que deja latexmk en `.lv/build/<perfil>/`): los avisos de pasadas anteriores ya resueltos no cuentan, que es lo que se quiere. El libro completo (127 KB de log, 51 cajas mal llenas) se parsea en 4 ms.
  - La sesión lee los problemas una vez por build, los deja en el `Finished` como conteo (`errors`, `warnings`, `badboxes`) y la interfaz pide la lista con `problems(perfil)`. Un build cancelado no reemplaza los problemas del anterior.

---

## 6. SyncTeX y búsqueda

### 6.1 Parser

- Parser propio de `.synctex.gz` en Rust, cargado una vez por build y cacheado por (ruta, mtime). Índice por archivo → línea → cajas, e índice espacial por página para la búsqueda inversa.
- Referencias: `synctex_parser.c` de TeX Live y la implementación TS de LaTeX Workshop (MIT).
- El CLI `synctex view`/`synctex edit` sirve de **oráculo** en los tests (puntos y líneas al azar sobre el libro) y de fallback si el parser falla **[decidido por S2]**: el CLI tarda de 320 a 590 ms por llamada en el libro (casi todo costo fijo de lanzar el proceso; 319 ms incluso con el SyncTeX más chico), contra 8 a 47 ms de cargar el archivo una vez por build con el parser y 0,5 a 2 µs por consulta. Con el PDF completo: 47 ms de carga y +18 MB de memoria. Concordancia con el CLI en el spike: forward 46/50 en la primera caja y 50/50 en páginas; inverse en líneas de texto 21/23; en figuras, ecuaciones y puntos sueltos todavía no coincide (criterio de qué hijo elegir), eso es trabajo de F4 contra el oráculo. Detalles del formato que hay que respetar (`docs/spikes/S2.md`): los `Input:` también aparecen en medio del contenido; la caja de un párrafo y sus hijos llevan líneas distintas; al refinar el inverse se ignoran los registros `x`; las cajas de tamaño cero se resuelven a la contenedora.

### 6.2 Código → PDF (forward)

1. Con el cursor (o la selección) en `archivo:línea:columna`, SyncTeX da las cajas de esa línea. pdfTeX no registra columna, así que un párrafo de 500 caracteres devuelve cajas en varias líneas del PDF.
2. El frontend toma la palabra bajo el cursor (o la selección) más 3 o 4 palabras de contexto, la pasa a "texto plano" (saca comandos, llaves, `~`, normaliza espacios, Unicode NFC, ligaduras fi/fl, cortes con guion al final de línea) y la busca en la capa de texto de PDF.js **dentro de las cajas** devueltas.
3. Resalta las palabras exactas (rectángulos superpuestos que se desvanecen en ~1,5 s) y desplaza el PDF sólo si no están a la vista, dejándolas a un tercio de la altura.
4. Si no hay coincidencia, resalta las cajas de la línea (comportamiento clásico).

### 6.3 PDF → código (inverse)

1. Doble clic (o Ctrl+clic) en el PDF: SyncTeX da `archivo:línea`.
2. El frontend toma la palabra clickeada y sus vecinas de la capa de texto y las busca con fuzzy match en esa línea (y ±2 líneas), sobre el texto plano de la fuente con un mapa de offsets plano → original.
3. Abre el archivo si hace falta, pone el cursor en la columna exacta, selecciona la palabra y la destella.
4. Si SyncTeX devuelve un archivo del preámbulo (por ejemplo `structure.tex`, porque el texto viene de una macro), buscar el texto clickeado en los archivos de la parte de esa página antes de rendirse.

### 6.4 Qué PDF usar (regla de `synctex_pdf.ps1`, generalizada)

1. Se resuelve la parte del archivo (4.3).
2. Si el perfil parcial incluye esa parte y su PDF tiene `.synctex.gz`, va ahí, aunque otro PDF sea más nuevo.
3. Si no, el más reciente entre los perfiles que contienen esa parte (rápido, completo) y tienen synctex.
4. Si eso implica cambiar el PDF que muestra el panel, se cambia y se avisa en la barra del visor.
5. Los PDF exportados no participan.

### 6.5 Modos

- Botones ← → en el separador editor/PDF (como Overleaf) y atajos.
- "Seguir al cursor": el PDF acompaña al cursor (debounce ~200 ms, sólo desplaza si el objetivo no está a la vista). Apagado por defecto.

### 6.6 Búsquedas de texto

- **En el archivo:** la de CodeMirror (Ctrl+F / Ctrl+H) con regex, mayúsculas y palabra completa.
- **En el proyecto:** core en Rust (Ctrl+Shift+F), resultados agrupados por archivo con contexto; reemplazo con vista previa. Por defecto sólo archivos del grafo; opción para todo el árbol.
- **En el PDF:** find controller de PDF.js, con el foco en el visor.
- Casos a cubrir en tests: figuras externalizadas (SyncTeX apunta al entorno), ecuaciones display, tablas, notas al pie, flotantes que caen lejos de su fuente.

---

## 7. Cache de figuras

Tres modos (`figureCache.mode`):

- **`project`:** el proyecto ya tiene su externalización (el libro: bloque al final de `structure.tex`, `\FigurasDe`). La app sólo define los flags, calcula el sello, cocina en paralelo, limpia y muestra estado. Es el modo para migrar el libro sin tocar su preámbulo.
- **`app`:** la app inyecta la externalización en proyectos que no la tienen:
  - `\AddToHook{package/tikz/after}`: `\usetikzlibrary{external}` + `\tikzexternalize[prefix=<dir>/]`.
  - Sólo dentro de `figure` si `onlyInFigureEnv` (por la fila 11 de la tabla).
  - Nombre `<sello>-<slug>-<n>` automático: con los hooks `file/before` / `file/after` se fija `\tikzsetfigurename` según el archivo actual (slug = hash corto de la ruta relativa), con una pila para que un `fig_*.tex` dentro de un capítulo no le cambie el nombre al resto del capítulo. `\FigurasDe`-like opcional para un slug legible.
  - El sello lo calcula la app (md5 de `stampFiles`, 6 hex) y lo pasa como macro en el driver: no depende de pdftexcmds ni del engine.
- **`off`.**

**Cache compartido entre perfiles.** Los PDF de las figuras caen siempre en `figuras-cache/` (la subcompilación de pgf no lleva `-output-directory`). El `.md5`, en cambio, lo escribe el job principal en el directorio de build de su perfil: después de cada build la app lo mueve a `figuras-cache/`, o el otro perfil recocina la figura (5.4, S1). Se mueve con `fs::rename` (misma unidad, atómico) y no copiando y borrando. Las dos carpetas del cache (`<cache>/` y `.lv/build/<perfil>/<cache>/`) las crea la app antes de cada build: TeX Live no las crea (5.4).

**Figuras que fallan o se cortan [revisión previa a F6].** pgf escribe el `.md5` nuevo de una figura **antes** de lanzar su subcompilación (`\tikzexternal@check@uptodate@mode`, en `tikzexternalshared.code.tex`). Si la subcompilación falla, o el build se cancela mientras corre, queda el `.md5` nuevo junto al PDF viejo (o a uno cortado) y pgf da la figura por al día desde ahí. Si la figura ya tenía PDF, ni siquiera hay error: pgf encuentra un archivo con ese nombre. Reproducido en la revisión: un `\comandoQueNoExiste` dentro de una figura deja el build con código 0, sin errores en el log principal y con la imagen anterior, y el build siguiente no la reintenta. La app de F2 lo empeora: mueve los `.md5` al cache compartido después de cualquier build, cancelado o fallido. Regla:

- Después de cada build y de cada cocción, la app verifica cada figura que se lanzó (las líneas `Invoking ... -jobname "<cache>/<figura>"` del stream o del log, o la lista de la cocción): que su `.log` no tenga `Fatal error` y que su PDF sea posterior al inicio y termine en `%%EOF`.
- Una figura que no pasa: se borran su PDF y su `.md5` (del cache y del directorio del perfil). El build siguiente la reintenta y, si sigue rota, pgf da su error `did NOT result in a usable output file` en el log principal. El error de la subcompilación (su `.log`, con el parser de 5.8) va al panel de problemas con el archivo y la línea de la figura.
- Al cancelar un build o una cocción, lo mismo con las figuras que estaban en vuelo.
- Al cache compartido sólo pasan los `.md5` de figuras verificadas.

Cocción en paralelo (ambos modos):

1. Pasada de listado con el perfil oculto `cocina`: **todas las partes**, flags `partial`, `externalize` y `figureList` (pgf en `mode=list and make`). No dibuja nada; escribe la figlist y los `.md5` en `.lv/build/cocina/`. Siempre todas las partes: la figlist de un parcial sólo nombra las figuras de sus partes, y la limpieza contra esa lista borraría las de los demás capítulos.
2. Pendiente = falta el PDF, o el `.md5` recién listado difiere **en contenido** del que está en el cache compartido. No por fecha: los `.md5` cambian de carpeta y una copia no siempre conserva el mtime (en Linux, `fs::copy` no lo hace).
3. Lanza las subcompilaciones de a N (`parallelJobs`, default = núcleos; medir 8, 12 y 16) con la misma línea de comandos que usa pgf (`-jobname "<cache>/<figura>"` y `\def\tikzexternalrealjob{lv-cocina}\input{lv-cocina}`), ventanas ocultas, cwd en la raíz y sin `-output-directory`. Como no pasan por latexmk, la app les pone ella `TEXINPUTS` con `.lv/drivers` (lo que en un build hace `.lv/latexmkrc`). Al terminar, cada figura pasa por la verificación de arriba.
4. **Prioridad:** primero las figuras del perfil activo (las que nombra el log de su último build, con el sello nuevo), después el build, después el resto. La cocción del resto cede el paso: si llega un pedido de build, deja de lanzar subcompilaciones, espera las que están en vuelo (unos segundos), corre el build y retoma. Nunca corren a la vez un build y una cocción.
5. Progreso en la UI (`figures:progress`, "cocinando 12/158" en la barra); si alguna falla, lista con su `.log` clickeable.

Disparo automático antes de un build que usa cache: si no hay ninguna figura del sello actual, o hay menos del 60 % de las del sello anterior. Es un md5 y dos listados de carpeta: gratis en un guardado normal. Lo decide la app antes de lanzar latexmk; el `latexmkrc` no podría (`PATH` reducido, 5.1).

Después de las figuras de un perfil no se vuelve a listar «el resto» si el listado del perfil ya fue el del documento entero (un perfil de todas las partes): no hay resto, y esa lista autoriza a limpiar igual que la de `Todo`.

**Saltear el listado [cierre de F6].** Un perfil `cacheOnly` cocina el documento entero antes de cada build, y el listado cuesta 7 a 9 s en el libro. Se saltea si la última cocción completa quedó del todo cocida (sin pendientes ni fallidas, con el PDF de cada figura de la figlist en el cache, ninguna figura rota sin arreglar) y desde entonces no cambió nada que pueda cambiar una figura: **la huella de las figuras** (`figcache::huella_de_figuras`, guardada en `.lv/figlist.json`). La huella es el md5 de: el sello; en cada archivo de una parte (lo que alcanza una parte, `\input` incluidos), los entornos `figure` y `tikzpicture` y las líneas que definen cosas (`\def`, `\newcommand`, `\tikzset`, `\setlength`, `\FigurasDe`, `\usepackage`...), de modo que el texto corrido no cuenta; y, en los archivos que no son de ninguna parte (preámbulo, raíz, `structure.tex`), el archivo entero. Es más conservadora que «el hash del cuerpo de cada `tikzpicture`»: una macro que cambia fuera de las figuras puede cambiar una y ese perfil no revisa el md5. Lo que no ve: un `.sty` propio fuera del grafo; ahí vale el botón Cocinar, que lista siempre. Lo que una figura lee desde adentro de su `tikzpicture` (un `\input`, una imagen) sí lo ve, ver el párrafo que sigue. **Archivos que una figura lee desde adentro de su `tikzpicture` [cierre de F6].** pgf decide si una figura cambió con el md5 del texto del dibujo tal como está escrito: con un `\input{datos}` adentro hashea esa línea y no `datos.tex`, y latexmk tampoco lo ve, porque con la figura en el cache el documento no abre el archivo. Reproducido en la revisión con TeX Live (cambiar `datos.tex`: 0 subcompilaciones y el PDF de la figura idéntico), y en el libro con los engranajes: `Secciones/fig_engranaje_pinon.tex` y `fig_engranaje_rueda.tex`, que emite `Herramientas/gen_engranajes.py`, entran por `\input` dentro de un `tikzpicture` del anexo de Cauer. Pasa en **todos** los perfiles. Regla:

- **El grafo marca esas inclusiones** (`Edge.en_tikz`, `ProjectIndex.datos_de_tikz`): `\input`, `\include`, `\includegraphics`, y `plot file {x}` / `table {x}` dentro del `tikzpicture`, llevando la cuenta de `\begin{tikzpicture}` y `\end{tikzpicture}` sin contar los comentarios. Lo que incluye un archivo que entró desde un `tikzpicture` también es del dibujo, y el «archivo del dibujo» sigue siendo el que tiene el `tikzpicture`. Con `onlyInFigureEnv` sólo cuentan los que están dentro de un `figure` (la marca de agua del template, con `remember picture, overlay`, no se externaliza: sin este filtro una imagen de `structure.tex` invalidaba las 159 figuras del libro).
- **En la huella entran enteros**, sean de una parte, `.tex` o binarios (por el md5 de sus bytes).
- **Para los perfiles normales y la cocción:** `.lv/tikz-datos.json` guarda el md5 de cada uno. Antes de cada build de un perfil que externaliza y antes de cada cocción (`figcache::invalidar_por_datos`), si alguno cambió, o es la primera vez que se lo ve, se borran los `.md5` de las figuras del archivo que lo incluye (todas las de su slug: el del archivo o, si éste no declara `\FigurasDe`, el de su parte; sin slug conocido, todas), en **todos los sellos** y en el cache y el directorio de cada perfil, y el `.fdb_latexmk` de cada perfil (sin él latexmk, que no ve el cambio, diría «nada que hacer»). Sin `.md5` pgf recocina la figura dentro del build y la lista de la cocción la da por pendiente; las dos pasan por la verificación de figuras.
- En el libro: correr `gen_engranajes.py` con otro ángulo de presión recocina las 2 figuras del anexo (14 s de cocción + 8 s de listado) y cambia 1 página del PDF (la 104, la de los engranajes).

**Medido en el libro (el `completo` con cache):** sin cambios 0,6 s de latexmk (1,1 s de reloj con el arranque del proceso), un cambio de texto 9,1 s, una figura editada 22 s (7,4 s de listado + 5 s de cocción de esa figura + 9 s de build); la comprobación para saltear el listado cuesta 28 a 33 ms.

Limpieza: borra todo lo que no esté en la última figlist **de `cocina`** (sellos viejos, figuras huérfanas), mostrando antes cuántos MB libera. Nunca contra la figlist de otro perfil. No es automática.

**El completo con cache [spike S5].** El completo tarda 338 s en la máquina de desarrollo (4 pasadas de ~82 s sin cache) y es lo más lento que queda. La fila 10 de la tabla lo deja sin cache porque la **subcompilación** de una figura tropieza con la portada y el `.toc`. Con `external/mode=graphics if exists`, pgf usa el PDF del cache si existe y, si no, dibuja la figura en línea: nunca subcompila. Se inyecta desde el driver (`\AddToHook{begindocument/before}{\tikzset{external/mode=graphics if exists}}`) con el flag `externalize` puesto, para que `\FigurasDe` nombre igual que en los otros perfiles. En ese modo pgf no mira el `.md5`, así que antes del completo corre una cocción (o se verifica que no haya pendientes). Mecanismo verificado en la revisión sobre `fixtures/tikz-figuras` (0 subcompilaciones; una figura borrada del cache se dibujó en línea). **Resultado de S5 y decisión de Juan (`docs/spikes/S5.md`).** Con el libro: el completo con cache tarda 36 s de build contra 330 s sin cache (9,2 s con un cambio de texto y sin `cleanBefore`). Mismas 198 páginas y mismo multiconjunto de palabras por página; el diff rasterizado no da cero (89 páginas, 0,03 % de los píxeles), de antialiasing de algunos glifos y de la fase de un rayado, sin nada visible. Decisión: **dos perfiles**. `completo` (con `cacheOnly`, sin `cleanBefore`) sirve para revisar el libro entero y **no publica**; `entrega` (sin cache, con `cleanBefore`) es el completo de siempre y el único que publica «Funciones de Aproximación.pdf». El PDF de entrega no depende del estado del cache (`graphics if exists` no mira el md5) y no carga los 806 subconjuntos de fuente de las figuras (4,1 contra 5,7 MB). El `cleanBefore` quedó solo en `entrega`: limpiar siempre fuerza 4 pasadas, y en la revisión no hace falta.

Panel "Figuras": figuras por archivo, estado (al día / pendiente / falló), tamaño del cache, botones Cocinar y Limpiar.

---

## 8. Exportación, vista previa de fragmento y variables

### 8.1 Exportación

- Exportar la parte del archivo abierto, una lista o todas, cada una a `export.dir` con `export.pattern`.
- Usa el perfil `export`: no toca la selección ni el PDF del parcial.
- `{num}` es el número de capítulo impreso, leído del `.aux` de la parte (`\numberline {8}`), no de la posición.

### 8.2 Vista previa de fragmento

Para iterar sobre una figura, una ecuación o una sección sin compilar la parte entera (el `\BancoDePruebas` de inspo, generalizado):

- Comando "Vista previa del entorno actual" (o de la selección). La app escribe el fragmento en `.lv/fragment/frag.tex` y un driver con flags parciales, `\includeonly{}` (no entra ninguna parte) y `\AddToHook{begindocument/end}{\input{.lv/fragment/frag}}`.
- Referencias resueltas sembrando los `.aux` como en 5.4. Comparte el cache de figuras.
- Se muestra en una pestaña "Fragmento" del visor, o en una ventana flotante.

### 8.3 Variables

- Cada variable de `latexviewer.json` aparece como selector en el menú de compilación y se escribe en el driver como `\def\<nombre>{<valor>}`.
- El valor vive en `.lv/state.json` (es de esta máquina, como el `opciones.tex` de inspo).
- Para que el driver gane, el proyecto tiene que definir su default con guardia (`\ifdefined\X\else\def\X{...}\fi`). El doctor detecta un `\def` incondicional de una variable declarada y lo avisa.

---

## 9. Historial y diagnóstico

- `.lv/history.jsonl`, una línea por build: perfil, inicio, fin, duración, pasadas (herramienta y duración de cada una, sacadas del stdout de latexmk con timestamps), figuras cocinadas, cocción en paralelo, `.aux`/`.fdb_latexmk` que faltaban, otros procesos de TeX corriendo, si el build anterior no terminó, código de salida, errores, warnings, overfull. Rotación al llegar a ~1 MB.
- Panel "Historial": tabla y, por build, una pista de por qué tardó ("faltaba el `.fdb_latexmk`: recompilación completa", "3 figuras cocinadas: 4,1 s").
- **Doctor** (al abrir un proyecto por primera vez y a pedido): distribución y versión de LaTeX (≥ 2021-06), `latexmk`, Perl, `synctex`, `biber`/`bibtex`, `makeindex`; `-shell-escape` necesario y permitido; raíz con nombre que rompa la externalización; partes por `\input` (no sirven para `\includeonly`); BOM en archivos que entran por `\input`; variables con `\def` incondicional; procesos huérfanos; `autoClean` de otras herramientas que borren auxiliares; que `pdflatex`, `latexmk` y `synctex` arranquen de verdad (una instalación de MiKTeX a medias deja lanzadores que salen con `0xC0000135`); y el `PATH` que ve Perl dentro de latexmk (si está reducido al `bin` de MiKTeX, avisar de que un `latexmkrc` no puede lanzar programas por nombre).

---

## 10. Interfaz

### 10.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Libro TC   [Parcial: Desnormalización ▾] [▶ Compilar ▾]  auto: al guardar   │
│                                            2,8 s · 0 errores · 3 avisos      │
├────────────┬──────────────────────────────────┬──────────────────────────────┤
│ Archivos   │ Desnormalización.tex × fig_x.tex │ ◀ 12/40 ▶  − 110 % +  ← →   │
│ Esquema    │                                  │                              │
│ Partes  ☑  │          CodeMirror              │           PDF.js             │
│ Buscar     │                                  │                              │
│ Figuras    │                                  │                              │
├────────────┴──────────────────────────────────┴──────────────────────────────┤
│ Problemas (3) · Log · Historial                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Barra superior: perfil activo y partes, botón Compilar con menú (perfiles, variables, auto-compilación, detenerse en el primer error, publicar, exportar, cancelar), duración y resultado del último build, spinner mientras compila con "pasada 2 · cocinando 3 figuras".
- Layouts: editor + PDF (default), sólo editor, sólo PDF, PDF en ventana aparte (segundo monitor). Ctrl+\ alterna.
- Pestañas de editor, pestaña modificada marcada, archivos cambiados afuera recargados solos si no hay cambios locales (si los hay: diálogo).
- Esquema: capítulos/secciones/subsecciones de todo el proyecto siguiendo el grafo, con labels; las partes con checkbox; las que están en el perfil activo, resaltadas.
- Tema claro y oscuro para la UI; el PDF queda en blanco (opción de invertir colores más adelante).
- Textos de la UI en español.

### 10.2 Editor

- Soft wrap por defecto, números de línea, resaltado de pares `{}` y `\begin`/`\end`, plegado por sección y por entorno.
- Autocompletado: comandos (base + los definidos en el proyecto), entornos (`\begin{` cierra solo con `\end{}`), `\ref{`/`\eqref{`/`\cref{` con los labels y una línea de contexto, `\cite{`/`\parencite{` con autor y título, rutas en `\input`/`\include`/`\includegraphics`.
- Ctrl+clic / F12: de `\ref` al `\label`, de `\cite` a la entrada del `.bib`, de `\input` al archivo, de `\includegraphics` a la imagen (vista previa al pasar el mouse).
- Lint liviano sin compilar: `\begin`/`\end` desbalanceados, labels duplicados, `\ref` a labels inexistentes.
- Guardado: preserva EOL (CRLF/LF/CR) y BOM tal como estaban en el archivo, byte a byte para lo que el usuario no tocó. Un archivo con **EOL mezclados** (o un CR suelto dentro de un CRLF) no se puede guardar "como estaba" sin conservar el EOL de cada línea, y el editor sólo conoce el texto normalizado: se abre en **sólo lectura** con un aviso, y recién si el usuario acepta ("Editar y normalizar") se guarda con el EOL dominante. Los archivos que no son UTF-8 (UTF-16, binarios, UTF-8 inválido) no se abren como texto.

### 10.3 Atajos

Todos configurables desde un `keybindings.json` en la config de la app. Hay que anular los atajos nativos del webview que choquen (Ctrl+P imprime, Ctrl+R/F5 recargan, Ctrl+F abre la búsqueda de WebView2) y el `Ctrl+M` de CodeMirror (toggle de tab focus).

**Formato.** Con selección envuelve; sin selección inserta y deja el cursor adentro; si ya está aplicado, lo saca (toggle); con multicursor, en cada selección. En modo matemático cambia el comando.

| Atajo | Texto | Matemática |
|---|---|---|
| Ctrl+B | `\textbf{…}` | `\mathbf{…}` |
| Ctrl+I | `\textit{…}` | `\mathit{…}` |
| Ctrl+E | `\emph{…}` | n/a |
| Ctrl+U | `\underline{…}` | `\underline{…}` |
| Ctrl+Shift+T | `\texttt{…}` | `\mathtt{…}` |
| Ctrl+M | `$…$` | n/a |
| Ctrl+Shift+M | `\[ … \]` | n/a |
| Ctrl+Shift+E | envolver en `\begin{▮}…\end{▮}` con multicursor en el nombre | |
| Ctrl+/ | comentar/descomentar con `%` | |

**Compilación**

| Atajo | Acción |
|---|---|
| Ctrl+S | guardar (y compilar si auto-compilación = al guardar) |
| Ctrl+Enter | guardar todo y compilar el perfil activo |
| Ctrl+Alt+C (y Ctrl+Mayús+Enter, el de F2) | compilar la parte del archivo abierto (pasa a ser la selección del parcial) |
| Ctrl+Alt+T | menú de compilación: perfiles, variables, exportar, cocinar, limpiar (como el Ctrl+Alt+T de inspo) |
| F8 / Shift+F8 | siguiente / anterior problema |

**Navegación y sync**

| Atajo | Acción |
|---|---|
| Ctrl+Alt+J | código → PDF (mismo atajo que inspo) |
| Doble clic / Ctrl+clic en el PDF | PDF → código |
| Ctrl+clic / F12 | ir a la definición |
| Shift+F12 | dónde se usa un label |
| Alt+← / Alt+→ | volver / avanzar en el historial de saltos |
| Ctrl+P | abrir archivo |
| Ctrl+Shift+P | paleta de comandos |
| Ctrl+Shift+O | ir a sección o label del archivo |
| Ctrl+T | ir a sección o label del proyecto |
| Ctrl+F / Ctrl+H | buscar / reemplazar en el archivo |
| Ctrl+Shift+F / Ctrl+Shift+H | buscar / reemplazar en el proyecto |
| Ctrl+\ | alternar layout |
| Ctrl+Tab | siguiente pestaña |

**Con el foco en el PDF:** Ctrl+F busca en el PDF, Ctrl+= / Ctrl+- / Ctrl+0 zoom, `W` ancho de página, RePág/AvPág, Inicio/Fin.

**Edición** (los de CodeMirror, que quedan): Ctrl+D siguiente ocurrencia, Alt+↑/↓ mover línea, Shift+Alt+↑/↓ duplicar, Ctrl+Shift+K borrar línea, Ctrl+Espacio autocompletar, Ctrl+] / Ctrl+[ indentar.

---

## 11. Pensando en colaboración (no ahora)

No se construye nada de esto. Sólo cuatro reglas para no cerrar la puerta:

- El frontend habla con el core sólo a través de la interfaz `Backend` (3.2). Mañana puede haber una implementación contra un servidor.
- `lv-core` es una biblioteca sin dependencias de Tauri.
- El contenido de cada documento abierto vive en el estado de CodeMirror y cambia por transacciones; no hay una segunda copia autoritativa en otro lado. Eso deja lugar para Yjs (`y-codemirror.next`) más adelante.
- Rutas relativas al proyecto en todo el protocolo y el estado.

---

## 12. Fases

Cada fase termina con: tests verdes, benchmarks anotados en `docs/benchmarks.md` (cuando aplica), checkboxes de este plan tildados y un commit. Los spikes de F0 van primero porque pueden cambiar decisiones.

### F0. Preparación y spikes

- [x] `git init`, `.gitignore` (incluye `inspo/`, `fixtures/libro-tc/`, `.lv/`), `CLAUDE.md`, esqueleto de carpetas.
- [x] `scripts/copiar-libro` y fixtures chicos (`scripts/compilar-fixtures.ps1` los compila: 6 casos verdes).
- [x] **S1** aislamiento de `.aux` + cache compartido (5.4). **Opción A**, con cuatro ajustes medidos; B como fallback (`docs/spikes/S1.md`).
- [x] **S2** latencia de SyncTeX: CLI contra parser propio sobre el PDF completo del libro. **Parser propio** (47 ms de carga, µs por consulta contra 320 a 590 ms del CLI); el CLI queda de oráculo (`docs/spikes/S2.md`).
- [x] **S3** recarga de PDF.js en WebView2 sin parpadeo y conservando posición, con el libro rápido (183 páginas, no ~150). **Dos visores con swap**, desarmando el viejo por completo (`docs/spikes/S3.md`).
- [x] **S4** `\includeonly` inyectado por `begindocument/before` y flags en el driver, compilando el libro con su raíz real. Confirmado: PDF idéntico píxel a píxel (`docs/spikes/S4.md`).
- [x] Medir la línea de base con los scripts de inspo sobre la copia: parcial, rápido, completo, sin cambios, cambio de estilo (`docs/benchmarks.md`).

### F1. Esqueleto

- [x] App Tauri que abre una carpeta, árbol de archivos, editor con pestañas, guardado con EOL/BOM preservados (`lv-core::fsio`: 12 casos de bytes, escritura atómica, conflicto de versión; archivos con EOL mezclados en sólo lectura).
- [x] Visor PDF.js con zoom y navegación (`src/pdf/viewer.ts`, con el desarmado completo de S3; el swap sin parpadeo es de F2).
- [x] Un build "completo" con latexmk, log crudo en el panel inferior (`lv-core::build`, esquema A de S1 más `INDEXSTYLE`; 320 a 347 s para el libro, igual que la línea de base).

Aceptación: abrir `fixtures/libro-tc`, editar un capítulo, guardar sin alterar el EOL ni agregar BOM (verificado por bytes), compilar el completo y verlo.

> **Ajuste de la aceptación (F1).** Decía "sin alterar CRLF", pero el libro de este snapshot es LF puro, sin BOM (los 50 archivos de texto; 8 sin salto final), así que probar CRLF sólo con `libro-tc` no probaría nada. La aceptación es: **preservar el EOL y el BOM que tenga el archivo en disco**, verificado por bytes sobre `libro-tc` (LF), sobre `fixtures/libro-include` (CRLF a propósito) y sobre casos sintéticos (BOM, mezcla, CR suelto, sin salto final, UTF-8 inválido, UTF-16). `scripts/aceptacion-f1.ps1 -Proyecto libro-tc|libro-include` lo corre dentro de la app real.

### F2. Motor de compilación y perfiles

- [x] `latexviewer.json` (leer, inferir, guardar), `.lv/state.json` (`lv-core::config`; los campos que no conoce se conservan; `latexviewer.json` roto se avisa y no se pisa; la configuración inferida se ofrece guardar, no se escribe sola).
- [x] Grafo de inclusión, partes, parte de un archivo (`lv-core::graph`: el libro, 50 `.tex` y 8 partes en 8 ms).
- [x] Drivers generados, perfiles, aislamiento de `.aux` según S1, sembrado (`lv-core::build` y `auxiliares`; flags, variables, `\includeonly` por hook, `-shell-escape` y motor por perfil, `cleanBefore`, `draftImages`).
- [x] Cola, coalescencia de guardados, cancelación con Job Objects, reparación de `.aux` truncado (`lv-core::session` y `procs`).
- [x] Auto-compilación (al guardar / al dejar de tipear / manual), aviso cuando el archivo guardado no está en el perfil (las tres políticas de 5.3).
- [x] Panel Partes con checkboxes, barra superior con perfil, partes, duración y estado (más "compilar la parte del archivo abierto" con Ctrl+Mayús+Enter, menú ⋯ con variables, publicar y guardar `latexviewer.json`).
- [x] Recarga del PDF sin parpadeo (swap de dos visores de S3: 0 cuadros en blanco y 0 de deriva en 40 recargas); último PDF bueno si falla, marcado como desactualizado.
- [x] Publicar (copia del PDF y del `.synctex.gz` a `publish.dir`; nunca se renombra el de trabajo).

Aceptación (sobre el libro, cache tibio): parcial ≤ 3,5 s de guardar a PDF visible; rápido ≤ 8 s; latexmk sin cambios ≤ 1 s y 0 pasadas; alternar parcial → rápido → parcial sin pasadas extra; referencias a capítulos excluidos resueltas en el parcial.

> **Ajuste por la línea de base (F0).** En la máquina de desarrollo (Ryzen 7 3700X, MiKTeX 26.5) los scripts de inspo dan parcial **4,7 s** y rápido **9,4 s** con cache tibio (`docs/benchmarks.md`), y el esquema de S1 4,5 a 5,0 s y 8,4 a 9,6 s: 3,5 s y 8 s quedan por debajo de lo que logra inspo acá y no se alcanzan sin mejoras de F10 (formato precompilado). Los umbrales de arriba valen para la máquina del autor, donde los números de inspo son ~3 s y ~7 s. En esta máquina el criterio es **no ser más lento que inspo**: parcial ≤ 5,0 s y rápido ≤ 9,6 s de guardar a PDF. Lo demás (≤ 1 s y 0 pasadas sin cambios, alternar sin pasadas extra, referencias resueltas) no cambia y ya se cumple en S1.

> **Resultado de F2 (smoke dentro de la app, `scripts/aceptacion-f2.ps1`, tres corridas iguales).** Parcial **4,93 s** de Ctrl+S a PDF visible (límite 5,0 s: está en el borde), rápido **9,25 s** (límite 9,6 s), sin cambios **0,6 s y 0 pasadas**, alternar P R P R **0 pasadas**, **0 referencias sin resolver** en el parcial, recarga del PDF **0 cuadros en blanco y 0 de deriva** en 40 recargas con la memoria plana después del primer cuarto. Detalle en `docs/benchmarks.md`.

### F3. Errores y avisos

- [x] Parser de log con fixtures reales (`fixtures/errores` y `fixtures/logs/`: error de sintaxis, comando indefinido, `\ref` y cita indefinidas, overfull, error de biber, archivo faltante; 11 pruebas más las de la sesión).
- [x] Gutter (marcador por severidad y línea subrayada, que sigue a las ediciones), panel de problemas con filtro por severidad y texto (pestaña Problemas | Log, que se abre sola cuando hay errores), F8 / Mayús+F8, contador en la barra superior.

Aceptación: el smoke `scripts/aceptacion-f3.ps1` (dentro de la app real sobre `fixtures/errores`) pasa los 10 pasos: build que falla con el conteo del log, panel, clic, gutter, F8 con teclado real, filtros, marcas que siguen a una edición, arreglo con el error de biber que queda y archivo faltante con su línea. Sobre el libro: el parser cuenta 51 cajas mal llenas, igual que un `grep` del log, en 4 ms.

### F4. SyncTeX

- [x] Parser e índice en Rust (`lv-core::synctex`, cacheado por mtime en la sesión), tests contra el CLI como oráculo (`fixtures/sync`: 9/9 y 27/27 en párrafos, 6/6 en líneas especiales).
- [x] Forward e inverse con refinamiento por palabra (`src/sync/`), resaltado que se desvanece, botones → PDF y ← Código en la barra del visor, Ctrl+Alt+J, doble clic o Ctrl+clic en el PDF.
- [x] Elección de PDF por especificidad (`Session::elegir_pdf`, con tests de las tres reglas); si cambia el PDF que se muestra, se cambia y se avisa.
- [x] "Seguir al cursor" (botón Seguir en la barra del visor; debounce de 200 ms; apagado por defecto; sólo desplaza y no cambia de PDF por su cuenta).

Aceptación: ≤ 150 ms por salto sobre el PDF completo; en 50 párrafos largos al azar del libro, el forward cae en la palabra correcta en ≥ 90 % y el inverse deja el cursor a ≤ 1 palabra de distancia en ≥ 90 %.

> **Resultado de F4 (`scripts/aceptacion-f4.ps1`, dentro de la app real sobre el libro, cuatro corridas iguales).** Forward **49/50**, inverse **49/50**, salto con mediana 7 a 8 ms, p95 14 a 18 ms y máximo 50 a 54 ms (el primero, que carga el SyncTeX). Se midió sobre el rápido (183 páginas) y no sobre el completo: el parser trabaja igual (S2: 47 ms de carga con el completo) y el rápido es el PDF con el que se trabaja. Detalle en `docs/benchmarks.md`.
>
> **Lo que no se implementó y se dice:** el **CLI `synctex` como fallback si el parser falla** (6.1) no está: el parser ya concuerda con el CLI en el 100 % de lo medido y un SyncTeX ilegible se avisa con un error claro (`Synctex::load` falla en un gz roto o cortado, con test); el CLI queda sólo como oráculo de los tests. Y la búsqueda en los archivos de la parte cuando SyncTeX devuelve un archivo del preámbulo (6.3, punto 4) tampoco: en ese caso el salto lleva a esa línea del preámbulo. Las dos cosas se retoman si el uso real las pide.

### F5. Editor y navegación

- [x] Atajos de formato (con toggle, multicursor, modo matemático) con tests unitarios por caso.
- [x] Keymap configurable, anulación de atajos nativos del webview.
- [x] Índice del proyecto, autocompletado, ir a definición, referencias, historial de saltos.
- [x] Esquema, abrir archivo rápido, paleta de comandos.
- [x] Búsqueda y reemplazo en el proyecto.
- [x] Lint liviano.

Aceptación: el índice del libro en menos de 1 s; cada atajo de 10.3 con evento de teclado real dentro de la app; el reemplazo en el proyecto escribe bytes exactos y se revierte al original.

> **Resultado de F5 (`scripts/aceptacion-f5.ps1`, dentro de la app real sobre `fixtures/editor`, 16 pasos).** El índice de símbolos del libro (38 `.tex`, 602 etiquetas, 198 secciones, 501 definiciones) tarda **13 ms** (el grafo, 9 ms más) y el lint no marca nada sobre el libro, que compila limpio (sin falsos positivos). La búsqueda en el proyecto: 16 ms sobre los archivos del grafo y 75 ms sobre todo el árbol (154 archivos). Detalle en `docs/benchmarks.md`.
>
> **Lo que cambió respecto del plan, y se dice:** (1) la búsqueda usa el crate `regex` y no `ignore` + `grep-searcher` (ver 3.1). (2) Se agrega `@codemirror/autocomplete`, que es parte de CodeMirror 6 y no cambia el stack. (3) Ctrl+Mayús+Enter queda como alias de Ctrl+Alt+C: es el atajo con el que F2 ya compilaba la parte activa. (4) `Ctrl+\` (alternar layout) y Ctrl+Alt+T (menú de compilación) de 10.3 no se hicieron: no hay todavía un layout alternativo ni ese menú, se retoman con F7 (variables y exportar). (5) La vista previa al pasar el mouse sobre un `\includegraphics` (10.2) queda para F10: hoy F12 sobre un `\includegraphics` informa la ruta de la imagen. (6) Ctrl+clic para ir a la definición está cableado (`ctrlClic` en `editor/extensions.ts`) pero el smoke sólo prueba F12: no hay forma confiable de mandar un clic con coordenadas reales sin automatizar el mouse.
>
> **Notas de implementación:** `keybindings.json` vive en el directorio de configuración de la app (`LV_CONFIG_DIR` lo redirige en los smokes) y se interpreta como `{ "comando": "Ctrl+X" | ["A","B"] | null }`; lo que no se entiende se avisa y se ignora, y ante un atajo repetido gana el primer comando en el orden del registro. Mientras hay un selector rápido abierto el despachador no atiende atajos (sólo frena los nativos). El historial de saltos guarda hasta 100 lugares y el origen de cada salto (definición, problema, inverse de SyncTeX, esquema, búsqueda).

### F6. Cache de figuras

> **Revisión previa a F6** (`docs/revision-pre-F6.md`): se agregan la cola de trabajos, la verificación de figuras que fallan o se cortan, el listado con todas las partes, las carpetas del cache, la prioridad de la cocción y el spike S5. Lo de la sección 7 marcado como de la revisión es parte de esta fase.

- [x] **Cola de trabajos, primero.** `Session` pasa de "un build y un pendiente" (`Builder::is_running` + `pendiente: Option<String>`) a una cola de trabajos tipados (`Build`, `Bake`; en F7 se suman `Export` y `Fragment`) con un solo ejecutor y un solo "ocupado". Un guardado durante una cocción queda pendiente igual que durante un build. Los tests de cola de F2 siguen pasando.
- [x] Carpetas del cache creadas antes de cada build; `move_md5` con `rename`; `max_print_line` en el entorno (5.1).
- [x] Verificación de figuras después de cada build, cocción y cancelación (7, "Figuras que fallan o se cortan"), con los errores de las figuras en el panel de problemas.
- [x] Modo `project` (para el libro) y modo `app` (probado en `fixtures/figuras-app`, con una copia sin su externalización propia).
- [x] Sello, listado con `cocina`, pendientes por contenido, cocción en paralelo con prioridad, disparo automático, limpieza, panel Figuras, progreso en la barra.
- [x] **S5:** el completo consumiendo el cache (7). Resultado en `docs/spikes/S5.md`: 36 s contra 330 s; el diff rasterizado no da cero (89 de 198 páginas, 0,03 % de los píxeles, antialiasing y la fase de un rayado) pero la paginación y el texto coinciden. **Decisión de Juan: dos perfiles**, `completo` (`cacheOnly`, para revisar, no publica) y `entrega` (el de siempre, sin cache, el único que publica).
- [x] **Archivos que entran dentro de un `tikzpicture` (pendiente de F6, sec. 7):** el grafo los marca, entran enteros en la huella y, en los perfiles normales y la cocción, un cambio en ellos borra los `.md5` de las figuras del archivo que los incluye. Test con TeX real sobre `fixtures/figuras-datos` y medido en el libro con `gen_engranajes.py`.
- [x] **Cierre de F6 (pedido tras S5):** el perfil `cacheOnly` saltea el listado previo cuando no cambió nada que pueda cambiar una figura (huella de las figuras, sec. 7) y no se pide un segundo listado del resto tras un perfil de todas las partes.

Aceptación: cambio de `estilo_figuras.tex` con las ~108 figuras en ≤ 60 s en una máquina de 12 núcleos; agregar una figura arriba del capítulo 1 recocina sólo las de ese archivo; deshacer el cambio de estilo no recocina nada.

Aceptación agregada en la revisión (en esta máquina):

- Después de un cambio de estilo, el PDF del parcial queda a la vista en lo que tarda cocinar **sus** figuras (46 en `Desnormalización`), no las 158; el resto termina después sin frenar los guardados.
- Una figura con un error se informa en el panel con su archivo y su línea, no queda la imagen vieja, y el build siguiente la sigue informando hasta que se arregla.
- Cancelar a mitad de una cocción o de un build que cocina no deja figuras cortadas ni `.md5` que las den por buenas (test con un latexmk/pdflatex falso que se mata en vuelo, y uno con TeX real).
- La limpieza, corrida con el parcial activo, no borra figuras de las partes que el parcial no incluye.
- El smoke de F2 sigue pasando: el chequeo del sello y la verificación de figuras suman menos de 20 ms a un guardado sin figuras nuevas.

> **Ajuste por la línea de base (F0).** El libro tiene hoy **158 figuras** (la figlist), no 108. El `cocinar_figuras.ps1` de inspo, de a 16 en el Ryzen 7 3700X (8 núcleos, 16 hilos), tarda **105 s** de cocción (114 s con el listado) contra los ~45 s del README. En esta máquina el criterio es **cocinar las 158 figuras en ≤ 105 s** (no ser más lenta que inspo), y los 60 s quedan para una máquina de 12 núcleos. Falta medir si el antivirus influye (riesgo de la sección 14). Deshacer el cambio de estilo ya no recocina nada en inspo (medido: 0 figuras, 4,7 s).

> **Resultado de F6 (números en `docs/benchmarks.md`, smoke `scripts/aceptacion-f6.ps1`).** Cambio de estilo: cocción de las 158 figuras en **103,0 s y 110,4 s** con 16 trabajos (+ 7 a 9 s de listado); figura nueva arriba del capítulo 1: **15 cocidas** (las del archivo), 17 s; deshacer el estilo: **0**; parcial a la vista a los **34 s** del cambio (sus 46 figuras: 25 s); chequeo previo a cada build **6 ms**; cancelar a mitad de una cocción: 209 ms y nada cortado. El smoke de F6 (7 pasos, 25 s) y los de F1 a F5 pasan.
>
> **Lo que cambió respecto del plan, y se dice:** (1) **El criterio de 105 s se cumple en una de las dos corridas de 16 trabajos y se pasa en la otra por un 5 %**; con 12 trabajos son ~121 s y con 8, ~157 s. (2) El modo `app` se probó sobre `fixtures/figuras-app` (nuevo, 3 archivos con `\include` y `\input`), no sobre `tikz-figuras`. (3) Se eligió el camino A de la puerta de decisión (subcompilación sin `-output-directory`, cwd en la raíz): en el libro no pisa los `.aux` de `\include` en paralelo y no hizo falta un directorio por ranura. (4) El nombre de cada figura en el modo `app` sale de `\CurrentFilePath/\CurrentFile` (con `\include{Secciones/x}` `\CurrentFile` es sólo `x.tex`); un archivo con nombre no ASCII queda con el nombre por omisión de pgf. (5) pgf escribe el `.md5` **antes** de lanzar la subcompilación y latexmk no cuenta un archivo borrado como cambio: la verificación borra PDF y `.md5` y además el `.fdb_latexmk` del perfil. (6) Con `\tikzexternalrealjob`, biblatex deja un `<job>.run.xml` en la raíz: se borra al terminar. (7) Se agrega `ProfileCfg.cacheOnly` por S5 (no estaba en el plan; apagado por omisión, y encendido en el `completo` de `fixtures/configs/libro-tc.latexviewer.json`, que gana además un perfil `entrega`). (8) Node: la máquina tiene **24.22, no 22** (cumple el `>= 22.13` de `pdfjs-dist`); se sacó `.npmrc` (`engine-strict=false`) y `npm ci`, los tests, `typecheck` y `tauri build` pasan sin avisos de `engines`. (9) No se midió el efecto del antivirus apagándolo (Defender en tiempo real, sin tocar sus exclusiones). (10) Hecho al cierre: tras las figuras de un perfil de todas las partes no se repite el listado del resto. (11) El smoke de F2 dio 5,2 a 5,4 s (parcial) y 9,9 a 10,2 s (rápido) de guardar a PDF visible, contra 4,93 y 9,25 de antes; con la máquina quieta, latexmk del motor de F5 y el de F6 sobre el mismo escenario, intercalados, dan **lo mismo** (parcial 4,7 s y 4,7 s; rápido 9,1 s y 8,9 s, medianas de 6): no es una regresión de F6, es la variación de la máquina de una corrida a otra (lo que la app suma a latexmk, 313 a 467 ms, está en el rango de F2).

### F7. Exportación, fragmentos y variables

- [ ] Exportar una, varias o todas las partes con el número impreso.
- [ ] Vista previa de fragmento.
- [ ] Variables en el menú de compilación.
- [ ] **Archivos cambiados afuera** (10.1, `fs:changed`; agregado en la revisión previa a F6: estaba en 3.1, 3.4 y 10.1 pero en ninguna fase). Watcher (`notify`) sobre el árbol del proyecto, sin `.lv/` ni el cache de figuras: una pestaña sin cambios se recarga sola, una con cambios avisa; el árbol de archivos y el índice se refrescan; un `.tex` que usa el perfil activo dispara la auto-compilación. Para el libro importa: los scripts de `Herramientas/` reescriben `Secciones/fig_*.tex`.

### F8. Historial, doctor y procesos

- [ ] `history.jsonl` y panel Historial con pistas.
- [ ] Doctor.
- [ ] Detección de huérfanos al abrir.

### F9. Migración del libro

Se hace en el repo real del libro, en una rama, con el OK de Juan antes de borrar nada.

- [ ] `latexviewer.json` del libro (el de 4.1, ajustado).
- [ ] `structure.tex`: el default de `\OpcionPie` con guardia y sin `\InputIfFileExists{opciones}`, para que gane el driver.
- [ ] Si S1 eligió la opción A, retirar `\CapitulosPorInput` (ya no hace falta traer capítulos por `\input`).
- [ ] `latexmkrc`: queda sólo lo propio del libro (`$makeindex` con `StyleInd.ist`, reglas custom); sale la elección de raíz, el registro, la cocción y `$out_dir`.
- [ ] Retirar `cap_actual.tex`, `libro_fast.tex`, `libro_cocina.tex`, `libro_export.tex`, `opciones.tex`, los `.ps1` de compilación (`compilar`, `opciones`, `exportar_capitulo`, `cocinar_figuras`, `synctex_pdf`, `menu`, `comun`), `Menu.bat` y las tareas/receta de `.vscode`.
- [ ] Actualizar `README.md` y `CLAUDE.md` del libro.
- [ ] **Paridad:** cada fila de la tabla de opciones de inspo (0 a 9 de Ctrl+Alt+T y las extra de `Menu.bat`) tiene su equivalente en la app, verificado a mano.
- [ ] **PDF idénticos:** comparar página a página (rasterizado + diff de imágenes) el PDF viejo y el nuevo de parcial, rápido y entrega (el perfil sin cache, equivalente a la opción 3 del menú de inspo; el `completo` con cache no entra: S5 midió 0,03 % de píxeles distintos). Las únicas diferencias admitidas son la fecha del pie y metadatos.

### F10. Extras (cuando lo anterior esté firme)

- [ ] Precompilar el preámbulo (`mylatexformat`) para el perfil parcial, con medición y fallback automático si falla. Es la optimización más grande que queda: el preámbulo del libro carga TikZ, biblatex y el template entero en cada pasada.
- [ ] Corrector ortográfico (es/en) con diccionario del proyecto.
- [ ] PDF en modo oscuro.
- [ ] Integración mínima con git (estado de archivos, diff del archivo actual).

---

## 13. Convenciones para trabajar en el repo (van al `CLAUDE.md`)

- Identificadores en inglés; comentarios, docs y textos de la UI en español.
- Todo archivo que genere la app: UTF-8 sin BOM. Nunca escribir LaTeX a través del shell (los backslashes se rompen): siempre por código o por Edit/Write.
- Antes de cambiar el stack, tocar `inspo/` o borrar algo del libro: preguntarle a Juan.
- Toda optimización se justifica con una medición en `docs/benchmarks.md` (antes y después, misma máquina).
- Los comentarios explican el porqué cuando la solución no es la obvia, como hace el libro: "se probó X y pasaba Y". Es lo que evita que alguien la deshaga.
- Tests: unitarios en `lv-core` (grafo, drivers, parser de log, parser de SyncTeX, sello, figlist), unitarios de frontend con Vitest (comandos de formato, normalización de texto para el sync), integración con TeX real marcada aparte (`cargo test --features tex`) para correr local.

---

## 14. Riesgos

| Riesgo | Mitigación |
|---|---|
| Externalización TikZ con aux en otra carpeta (S1) | Resuelto en MiKTeX con `TEXINPUTS` y mover los `.md5` (5.4). TeX Live 2022 probado con un fixture en la revisión previa a F6: anda si la app crea las carpetas del cache. El libro entero en TeX Live, sin probar: opción B como fallback |
| pgf da por al día una figura cuya subcompilación falló o se cortó (escribe el `.md5` antes de subcompilar) y deja la imagen vieja sin error | Verificación de cada figura lanzada (7), en F6 |
| latexmk sin Perl en MiKTeX | El doctor lo detecta y explica cómo instalarlo |
| `PATH` reducido dentro de latexmk (MiKTeX 26.5): lo que el `latexmkrc` lance por nombre falla en silencio | La app lanza ella lo que no sea TeX; el doctor lo detecta (`system()` desde un rc de prueba) |
| MiKTeX a medio actualizar: lanzadores viejos junto a utilidades nuevas (`pdflatex.exe` de 2023 con `0xC0000135`, visto en esta máquina) | El doctor ejecuta `pdflatex`, `latexmk` y `synctex` y avisa si salen con código de DLL no encontrada |
| Tiempos de compilación mayores que los del README en máquinas más lentas | Umbrales de aceptación relativos a la línea de base medida en la máquina (F2, F6) |
| PDF.js con libros grandes en WebView2 (memoria, tiempo de render) | Medido en S3: ~0,7 GB estables con el libro de 183 a 194 páginas si el visor viejo se desarma bien (5.7); la fuga de ~33 MB por recarga aparece si no. Falta medir el pico durante el swap y el uso con zoom alto o pantalla 4K |
| `pdfjs-dist` 6.x declara Node ≥ 22.13 y la máquina de desarrollo tiene Node 20, que además terminó su soporte el 30/4/2026 | Pasar la máquina a Node 22 LTS y sacar `engine-strict=false` de `.npmrc`. En la revisión previa a F6, `npm ci`, los 177 tests y el typecheck pasaron con Node 22.23 |
| SyncTeX impreciso en macros, tablas y flotantes | Refinamiento por texto y búsqueda en los archivos de la parte |
| Hooks de LaTeX en distribuciones viejas | Versión mínima verificada por el doctor |
| Antivirus de Windows frenando decenas de pdflatex en paralelo | Medir en F6; `parallelJobs` configurable |
| Cancelar un build deja `.aux` corruptos | No se cancela por guardar; reparación automática (5.5) |

---

## 15. Fuera de alcance

Colaboración en tiempo real, cuentas, nube, edición visual/WYSIWYG, gestor de paquetes de TeX, soporte de otros formatos (Markdown, Typst).
