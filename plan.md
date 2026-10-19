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
| 10 | Externalizar en el libro completo rompe (`\includepdf` con tildes en la ruta, `.toc` a medio escribir) | El completo no usa cache | Externalización configurable por perfil; el completo va sin cache por defecto |
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
| 21 | Los `.tex` son UTF-8 sin BOM con CRLF; un BOM en un archivo que entra por `\input` se cuela como carácter | Convención + `UTF8SinBOM` en los scripts | El editor preserva EOL y BOM de cada archivo; todo lo que genera la app es UTF-8 sin BOM |
| 22 | Cada párrafo es una línea larga | Convención | Soft wrap por defecto; sync por palabra |
| 23 | Overfull `\hbox` | `compilar.ps1` los cuenta | Panel de problemas, con salto a la línea |

---

## 3. Stack y arquitectura

### 3.1 Stack [decidido, salvo que un spike diga otra cosa]

- **Shell:** Tauri 2 (Rust). Liviano, multiventana (PDF en un segundo monitor), WebView2 en Windows.
- **Frontend:** React + TypeScript + Vite. Estado con Zustand. Paneles redimensionables (`react-resizable-panels` o similar). Estilos a criterio (CSS modules o Tailwind), sin librería de componentes pesada.
- **Editor:** CodeMirror 6 (lo mismo que usa Overleaf). Gramática LaTeX: evaluar `codemirror-lang-latex` contra `@codemirror/legacy-modes` (stex). Requisito mínimo del árbol: saber si el cursor está en modo matemático, dentro de qué entorno y dentro de qué comando.
- **PDF:** `pdfjs-dist` con su `PDFViewer` (render perezoso de páginas, capa de texto, find controller).
- **Core en Rust:** `tokio` (procesos), `notify` (watcher), `flate2` (synctex.gz), `ignore` + `grep-searcher` (búsqueda), `serde`, `md-5`, Job Objects en Windows.
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

Comandos: `open_project(path)`, `get_index()`, `read_file(rel)` → `{text, eol, bom}`, `write_file(rel, text)` (restaura EOL y BOM), `set_selection(parts[])`, `set_variable(name, value)`, `build(profile)`, `cancel_build()`, `synctex_forward(rel, line, col)`, `synctex_inverse(profile, page, x, y)`, `search(query, opts)`, `replace(...)`, `bake_figures()`, `clean_figure_cache()`, `export_parts(parts[] | "all")`, `preview_fragment(rel, from, to)`, `doctor()`.

Eventos: `build:queued|started|pass|log|finished`, `figures:progress`, `fs:changed`, `index:updated`.

---

## 4. Modelo de proyecto

### 4.1 Archivos

| Archivo | Versionado | Qué tiene |
|---|---|---|
| `latexviewer.json` (raíz del proyecto) | sí | raíz, engine, partes, flags, perfiles, cache de figuras, variables, exportación |
| `.lv/` | no (la app lo agrega al `.gitignore`) | drivers generados, builds, estado, historial |
| `.lv/state.json` | no | perfil activo, partes elegidas, valores de variables, layout |
| settings y keybindings globales (dir de config de la app) | n/a | preferencias del usuario, atajos |

Sin `latexviewer.json`, la app lo infiere al abrir (la raíz es el `.tex` con `\documentclass` y `\begin{document}`; si hay varios, pregunta) y ofrece guardarlo.

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
    "completo": { "label": "Libro completo",  "partial": false, "externalize": false, "cleanBefore": true, "autoCompile": false },
    "export":   { "label": "Exportación",     "partial": true,  "externalize": true,  "parts": "one", "hidden": true }
  },
  "publish": { "dir": "../PDF", "names": { "completo": "Funciones de Aproximación.pdf" } },
  "export":  { "dir": "../PDF/Capítulos", "pattern": "{num:02} - {name}.pdf" }
}
```

`"completo"` lleva `autoCompile: false` a propósito: si pudiera quedar elegido para el guardado, cada Ctrl+S sería una corrida de un minuto (lo mismo que en inspo, donde el completo no es receta).

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
- Ancho de línea del log: `max_print_line=10000` (variable de entorno en TeX Live; en MiKTeX verificar `--max-print-line`). Sin eso el log corta a 79 columnas y rompe rutas.
- `.lv/latexmkrc` lo genera la app y se lee **después** del `latexmkrc` del proyecto, que sigue valiendo para reglas propias (makeindex con estilo, glossaries, nomencl). Lo de la app pisa `@default_files`, `$out_dir`/`$aux_dir` y lo que haga falta, y pone `TEXINPUTS` con `.lv/drivers` (5.4). Ojo: dentro de latexmk el `PATH` queda reducido al `bin` de MiKTeX (medido con MiKTeX 26.5, ver `docs/benchmarks.md`): el rc no puede lanzar por nombre programas que no estén ahí (`powershell`, `tasklist`), y falla en silencio. Lo que haga falta fuera de TeX lo lanza la app, no el rc.
- `-recorder` (default en latexmk) deja el `.fls`: es la lista exacta de archivos que usó cada perfil. Se usa para decidir si un guardado afecta al perfil activo.

### 5.2 Salidas

- Cada perfil compila en `.lv/build/<perfil>/` y su PDF se llama `lv-<perfil>.pdf`, con su `.synctex.gz` al lado.
- "Publicar" (opcional, por perfil) **copia** PDF y `.synctex.gz` a `publish.dir` con el nombre configurado. Nunca se renombra en el lugar (fila 3 de la tabla).
- El visor lee el PDF en memoria (bytes por comando), nunca deja un handle abierto: en Windows un PDF abierto bloquea la escritura de pdflatex.

### 5.3 Perfiles y qué compila el guardado

- El perfil activo se elige en la barra superior. Lo que compila Ctrl+S es siempre el perfil activo.
- **Partes elegidas:** checkboxes en el panel Partes y en el esquema. "Sólo esta" con un clic. Atajo para "compilar la parte del archivo abierto" (opción 1 del menú de inspo).
- **Guardar un archivo que el perfil activo no usa** (no está en su `.fls` ni en su grafo): por defecto aviso no intrusivo con botón "Compilar esta parte". Configurable: avisar | cambiar la selección a esa parte | compilar igual.
- **Modo de auto-compilación:** al guardar (default) | al dejar de tipear N ms (con autoguardado) | manual.
- Opción por perfil `draftImages`: `\PassOptionsToPackage{draft}{graphicx}` en el driver, para proyectos con muchas imágenes.

### 5.4 Aislamiento de `.aux` **[decidido por el spike S1: opción A]**

Objetivo: que alternar perfiles no cueste pasadas extra ni pueda dejar un `.aux` truncado a otro perfil, y que en el parcial las referencias a partes excluidas sigan resolviendo (con `\includeonly`, LaTeX las saca de los `.aux` de esas partes).

- **Opción A (elegida):** auxiliares y PDF por perfil (`$out_dir`/`$aux_dir` de latexmk en `.lv/build/<perfil>/`), drivers en `.lv/drivers/`. Medido con el libro real en `docs/spikes/S1.md`: cumple los cuatro criterios (referencias correctas en parcial y rápido, 0 pasadas al alternar, cache de figuras compartido, SyncTeX 10/10) con los mismos tiempos que inspo. Necesita **cuatro ajustes**, sin los cuales falla:
  1. **`TEXINPUTS` con `.lv/drivers`**, puesto desde `.lv/latexmkrc`. Sin eso la subcompilación de pgf (`\input{lv-<perfil>}` desde la raíz) no encuentra el driver y el build falla cuando hay que cocinar una figura.
  2. **Mover los `.md5` al cache compartido** después de cada build: con `-output-directory` pgf escribe el `.md5` nuevo en `.lv/build/<perfil>/figuras-cache/`, y el otro perfil, que lee el de `figuras-cache/`, recocina la misma figura (medido: 23,8 s en vez de 9,4 s).
  3. **Sembrado:** antes de un build parcial, para cada parte excluida se copia su `.aux` desde el build más reciente que lo tenga (rápido o completo) si es más nuevo que el propio, y sólo si el contenido difiere (así no se toca el mtime de lo que ya es igual y no se provocan pasadas). **No se siembra desde un build sospechoso** (falló o se canceló): propaga un `.aux` truncado. Como el rápido usa `\include` sin pisar a nadie, deja siempre `.aux` frescos de todas las partes.
  4. **Reparación de `.aux` truncado** (5.5), que cuesta un build en frío de `.aux` (36 a 39 s para el rápido).
- **Subcarpetas de `\include`:** la app las crea antes dentro del directorio de salida. MiKTeX las crea solo (medido), TeX Live no: se sigue creando por portabilidad.
- **Opción B (fallback, también cumple todo en S1):** todo en la raíz del proyecto como inspo, con drivers `lv-<perfil>.tex` en la raíz y jobnames distintos, y la app **intercambia** los `.aux` de partes: al terminar un build bueno los guarda en `.lv/aux/<perfil>/` y antes del siguiente build de ese perfil los restaura. No necesita `TEXINPUTS` ni mover `.md5`, pero deja los auxiliares y los drivers en la raíz.
- **Sin probar:** TeX Live (sólo hay MiKTeX en la máquina de desarrollo). `-output-directory` se comporta distinto ahí (escribe en el directorio de salida todo `\openout` relativo). Lo cubre un test de integración con TeX real cuando haya una máquina con TeX Live; B es el fallback.

### 5.5 `.aux` truncado

- Si el build falla con `File ended while scanning use of \@newl@bel` (o similar en un `.aux`; también sale como `\BKM@entry`, el `.out` de bookmark), la app borra (A) o restaura del snapshot (B) los `.aux` del perfil y reintenta una vez sola, avisando en el historial. Medido en S1: sin esa reparación el perfil cortado falla en todos los builds siguientes; con ella el rápido se recupera en un build en frío de `.aux` (36 a 39 s).

### 5.6 Cola y cancelación

- Un solo build activo por proyecto (los perfiles comparten el cache de figuras).
- Guardar durante un build lo marca **pendiente**; al terminar, corre una sola vez más (se coalescen los guardados). No se mata un build por un guardado.
- Cancelar es explícito (botón). Mata el árbol de procesos con Job Objects y marca los `.aux` del perfil como sospechosos (5.5): no se reutilizan ni se siembran desde ahí (5.4, S1) hasta que un build del perfil termine bien.
- Al abrir un proyecto: si hay `pdflatex`/`latexmk` huérfanos del proyecto, avisar y ofrecer matarlos.

### 5.7 Recarga del PDF

- Si el build terminó bien, recargar el PDF sin parpadeo: render en segundo plano y swap, conservando página, zoom y desplazamiento dentro de la página. **[decidido por S3]** Se hacen con **dos visores superpuestos**: el nuevo se arma y se pinta detrás, recibe la misma posición, y cuando sus páginas visibles terminaron de pintarse pasa adelante y el viejo se destruye. Medido con el libro (183 y 194 páginas): 0 cuadros en blanco y 0 de deriva en más de 130 recargas, ~220 a 230 ms hasta lo visible. El `setDocument` sobre el mismo visor deja 4 a 9 cuadros en blanco por recarga y a veces pierde la posición (salto de 59 páginas): descartado (`docs/spikes/S3.md`).
- **El visor viejo se desarma por completo, y eso lleva test:** `abortSignal` en `PDFViewer` (abortada al destruirlo), `viewer.cleanup()`, canvas a tamaño cero, `await loadingTask.destroy()` y `await doc.destroy()`. Sin eso la memoria crece ~33 MB por recarga sin estabilizarse (1785 MB a las 40 recargas del rápido); con eso queda en ~0,7 GB. Criterio de aceptación: memoria estable a 40 recargas seguidas.
- Si falló o no hay PDF nuevo, queda el último bueno, con un borde o cartel de "desactualizado" y el panel de problemas abierto.
- Opción "detenerse en el primer error" (`-halt-on-error`), apagada por defecto.

### 5.8 Errores y advertencias

- Parser del log propio: pila de archivos por paréntesis, `archivo:línea:` de `-file-line-error`, `l.<n>`, `LaTeX Warning: Reference ... on input line N`, `Overfull/Underfull \hbox ... at lines a--b`, citas indefinidas, errores de biber y makeindex (sus propios logs).
- Marcas en el gutter, subrayado de la línea, panel de problemas con filtro, F8 / Shift+F8 para recorrerlos.
- Tests con logs reales guardados en `fixtures/logs/`.

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

**Cache compartido entre perfiles.** Los PDF de las figuras caen siempre en `figuras-cache/` (la subcompilación de pgf no lleva `-output-directory`). El `.md5`, en cambio, lo escribe el job principal en el directorio de build de su perfil: después de cada build la app lo mueve a `figuras-cache/`, o el otro perfil recocina la figura (5.4, S1).

Cocción en paralelo (ambos modos):

1. Pasada de listado con el flag `figureList` (pgf en `mode=list and make`): no dibuja nada, escribe la figlist y los `.md5`.
2. Pendiente = falta el PDF, o el `.md5` es más nuevo que el PDF.
3. Lanza las subcompilaciones de a N (`parallelJobs`, default = núcleos) con la misma línea de comandos que usa pgf (`-jobname "<figura>"` y `\def\tikzexternalrealjob{<job>}\input{<driver>}`), ventanas ocultas.
4. Progreso en la UI; si alguna falla, lista con su `.log` clickeable.

Disparo automático antes de un build que usa cache: si no hay ninguna figura del sello actual, o hay menos del 60 % de las del sello anterior. Es un md5 y dos listados de carpeta: gratis en un guardado normal.

Limpieza: borra todo lo que no esté en la última figlist (sellos viejos, figuras huérfanas), mostrando antes cuántos MB libera.

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
- Guardado: preserva EOL (CRLF/LF) y BOM tal como estaban en el archivo.

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
| Ctrl+Alt+C | compilar la parte del archivo abierto (pasa a ser la selección del parcial) |
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

- [ ] App Tauri que abre una carpeta, árbol de archivos, editor con pestañas, guardado con EOL/BOM preservados.
- [ ] Visor PDF.js con zoom y navegación.
- [ ] Un build "completo" con latexmk, log crudo en el panel inferior.

Aceptación: abrir `fixtures/libro-tc`, editar un capítulo, guardar sin alterar CRLF ni agregar BOM (verificado por bytes), compilar el completo y verlo.

### F2. Motor de compilación y perfiles

- [ ] `latexviewer.json` (leer, inferir, guardar), `.lv/state.json`.
- [ ] Grafo de inclusión, partes, parte de un archivo.
- [ ] Drivers generados, perfiles, aislamiento de `.aux` según S1, sembrado.
- [ ] Cola, coalescencia de guardados, cancelación con Job Objects, reparación de `.aux` truncado.
- [ ] Auto-compilación (al guardar / al dejar de tipear / manual), aviso cuando el archivo guardado no está en el perfil.
- [ ] Panel Partes con checkboxes, barra superior con perfil, partes, duración y estado.
- [ ] Recarga del PDF sin parpadeo; último PDF bueno si falla.
- [ ] Publicar (copia).

Aceptación (sobre el libro, cache tibio): parcial ≤ 3,5 s de guardar a PDF visible; rápido ≤ 8 s; latexmk sin cambios ≤ 1 s y 0 pasadas; alternar parcial → rápido → parcial sin pasadas extra; referencias a capítulos excluidos resueltas en el parcial.

> **Ajuste por la línea de base (F0).** En la máquina de desarrollo (Ryzen 7 3700X, MiKTeX 26.5) los scripts de inspo dan parcial **4,7 s** y rápido **9,4 s** con cache tibio (`docs/benchmarks.md`), y el esquema de S1 4,5 a 5,0 s y 8,4 a 9,6 s: 3,5 s y 8 s quedan por debajo de lo que logra inspo acá y no se alcanzan sin mejoras de F10 (formato precompilado). Los umbrales de arriba valen para la máquina del autor, donde los números de inspo son ~3 s y ~7 s. En esta máquina el criterio es **no ser más lento que inspo**: parcial ≤ 5,0 s y rápido ≤ 9,6 s de guardar a PDF. Lo demás (≤ 1 s y 0 pasadas sin cambios, alternar sin pasadas extra, referencias resueltas) no cambia y ya se cumple en S1.

### F3. Errores y avisos

- [ ] Parser de log con fixtures reales (error de sintaxis, `\ref` indefinida, cita indefinida, overfull, error de biber, archivo faltante).
- [ ] Gutter, panel de problemas, F8/Shift+F8, contador en la barra.

### F4. SyncTeX

- [ ] Parser e índice en Rust, tests contra el CLI como oráculo.
- [ ] Forward e inverse con refinamiento por palabra, resaltado, botones y atajos.
- [ ] Elección de PDF por especificidad.
- [ ] "Seguir al cursor".

Aceptación: ≤ 150 ms por salto sobre el PDF completo; en 50 párrafos largos al azar del libro, el forward cae en la palabra correcta en ≥ 90 % y el inverse deja el cursor a ≤ 1 palabra de distancia en ≥ 90 %.

### F5. Editor y navegación

- [ ] Atajos de formato (con toggle, multicursor, modo matemático) con tests unitarios por caso.
- [ ] Keymap configurable, anulación de atajos nativos del webview.
- [ ] Índice del proyecto, autocompletado, ir a definición, referencias, historial de saltos.
- [ ] Esquema, abrir archivo rápido, paleta de comandos.
- [ ] Búsqueda y reemplazo en el proyecto.
- [ ] Lint liviano.

### F6. Cache de figuras

- [ ] Modo `project` (para el libro) y modo `app` (probado en `fixtures/tikz-figuras`).
- [ ] Sello, listado, cocción en paralelo, disparo automático, limpieza, panel Figuras.

Aceptación: cambio de `estilo_figuras.tex` con las ~108 figuras en ≤ 60 s en una máquina de 12 núcleos; agregar una figura arriba del capítulo 1 recocina sólo las de ese archivo; deshacer el cambio de estilo no recocina nada.

> **Ajuste por la línea de base (F0).** El libro tiene hoy **158 figuras** (la figlist), no 108. El `cocinar_figuras.ps1` de inspo, de a 16 en el Ryzen 7 3700X (8 núcleos, 16 hilos), tarda **105 s** de cocción (114 s con el listado) contra los ~45 s del README. En esta máquina el criterio es **cocinar las 158 figuras en ≤ 105 s** (no ser más lenta que inspo), y los 60 s quedan para una máquina de 12 núcleos. Falta medir si el antivirus influye (riesgo de la sección 14). Deshacer el cambio de estilo ya no recocina nada en inspo (medido: 0 figuras, 4,7 s).

### F7. Exportación, fragmentos y variables

- [ ] Exportar una, varias o todas las partes con el número impreso.
- [ ] Vista previa de fragmento.
- [ ] Variables en el menú de compilación.

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
- [ ] **PDF idénticos:** comparar página a página (rasterizado + diff de imágenes) el PDF viejo y el nuevo de parcial, rápido y completo. Las únicas diferencias admitidas son la fecha del pie y metadatos.

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
| Externalización TikZ con aux en otra carpeta (S1) | Resuelto en MiKTeX con `TEXINPUTS` y mover los `.md5` (5.4). TeX Live sin probar: opción B, que cumple todo, como fallback |
| latexmk sin Perl en MiKTeX | El doctor lo detecta y explica cómo instalarlo |
| `PATH` reducido dentro de latexmk (MiKTeX 26.5): lo que el `latexmkrc` lance por nombre falla en silencio | La app lanza ella lo que no sea TeX; el doctor lo detecta (`system()` desde un rc de prueba) |
| MiKTeX a medio actualizar: lanzadores viejos junto a utilidades nuevas (`pdflatex.exe` de 2023 con `0xC0000135`, visto en esta máquina) | El doctor ejecuta `pdflatex`, `latexmk` y `synctex` y avisa si salen con código de DLL no encontrada |
| Tiempos de compilación mayores que los del README en máquinas más lentas | Umbrales de aceptación relativos a la línea de base medida en la máquina (F2, F6) |
| PDF.js con libros grandes en WebView2 (memoria, tiempo de render) | Medido en S3: ~0,7 GB estables con el libro de 183 a 194 páginas si el visor viejo se desarma bien (5.7); la fuga de ~33 MB por recarga aparece si no. Falta medir el pico durante el swap y el uso con zoom alto o pantalla 4K |
| `pdfjs-dist` 6.x declara Node ≥ 22.13 y la máquina de desarrollo tiene Node 20 | El build con Vite funcionó igual; fijar la versión de Node o de `pdfjs-dist` en F1 |
| SyncTeX impreciso en macros, tablas y flotantes | Refinamiento por texto y búsqueda en los archivos de la parte |
| Hooks de LaTeX en distribuciones viejas | Versión mínima verificada por el doctor |
| Antivirus de Windows frenando decenas de pdflatex en paralelo | Medir en F6; `parallelJobs` configurable |
| Cancelar un build deja `.aux` corruptos | No se cancela por guardar; reparación automática (5.5) |

---

## 15. Fuera de alcance

Colaboración en tiempo real, cuentas, nube, edición visual/WYSIWYG, gestor de paquetes de TeX, soporte de otros formatos (Markdown, Typst).
