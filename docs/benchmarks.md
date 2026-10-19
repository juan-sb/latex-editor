# Benchmarks

Toda optimización de la app se justifica con una medición de este archivo: antes y después, en la misma máquina. Las mediciones crudas salen de `scripts/` y quedan en `scripts/out/` (ignorada por git); acá van sólo los números que valen.

## Máquina y versiones

| | |
|---|---|
| CPU / RAM | AMD Ryzen 7 3700X, 8 núcleos / 16 hilos, 16 GB |
| SO | Windows 11 Pro 10.0.26200 |
| MiKTeX | 26.5 (LaTeX 2026-06-01, pdfTeX 3.141592653-2.6-1.40.29) |
| latexmk | 4.88 (9 mar 2026) |
| Perl | ActiveState 5.36.0 |
| biber | 2.22 |

Para comparar: el README del libro se escribió con MiKTeX 25.4 y latexmk 4.87, y sus tiempos son de la máquina del autor (la cocción en paralelo la mide con 12 núcleos).

## Línea de base: los scripts de inspo tal cual

Copia de `inspo/Proyecto` en `fixtures/libro-tc` (`scripts/copiar-libro.ps1 -Limpio`), compilada con el `latexmkrc` y los scripts de inspo sin modificar. Los comandos son los de `compilar.ps1` y de la receta de VS Code:

```
latexmk -pdf -shell-escape -interaction=nonstopmode -synctex=1 cap_actual.tex   (parcial)
latexmk -pdf -shell-escape -interaction=nonstopmode -synctex=1 libro_fast.tex   (rápido)
Herramientas\compilar.ps1 -Que completo                                         (limpia antes)
```

`scripts/bench-base.ps1` corre los escenarios en orden y lee pasadas y figuras cocinadas del `registro-compilacion.txt` que escribe el `latexmkrc`. Las repeticiones de los escenarios tibios son 3 (mediana y rango); los escenarios en frío se miden una vez. Antes de medir se compiló el libro completo una vez para que MiKTeX instalara lo que le faltaba.

"Cambio chico" = una palabra nueva en un párrafo de texto plano de `Secciones/Desnormalización.tex`, el capítulo de `\includeonly` de `cap_actual`.

El libro tiene 194 páginas, 158 figuras externalizables (la figlist) y 161 `tikzpicture` en `Secciones/`.

| Escenario | n | Reloj (s) | Pasadas de pdflatex | Figuras cocinadas |
|---|---|---|---|---|
| Parcial en frío (sin cache ni `.aux`) | 1 | **197,8** | 3 (186,0 + 3,6 + 3,5), 1 biber | 46 |
| Parcial sin cambios | 3 | **0,6** (0,6 a 0,6) | 0 | 0 |
| Parcial, cambio chico | 3 | **4,7** (4,7 a 4,8) | 1 (3,5 a 3,7) | 0 |
| Rápido, primera vez (cache a medias) | 1 | 620,0 | 4 (589,3 + 7,9 + 7,6 + 7,8), 1 biber | 112 |
| Rápido sin cambios | 3 | **0,7** (0,7 a 0,8) | 0 | 0 |
| Rápido, cambio chico | 3 | **9,4** (9,1 a 9,8) | 1 (7,7 a 8,2) | 0 |
| Alternar parcial ↔ rápido ↔ parcial ↔ rápido | 4 | 0,6 a 0,7 cada una | 0 en las cuatro | 0 |
| Completo, limpio | 1 | **338,5** | 4 (82,9 + 81,9 + 82,0 + 83,7), 1 biber | 0 (no usa cache) |
| Completo sin cambios | 2 | **0,6** | 0 | 0 |
| Cambio de estilo, parcial (cocción serial de pgf) | 1 | **183,0** | 1 (181,7) | 46 |
| Cambio de estilo, otra pasada sin más cambios | 1 | 0,6 | 0 | 0 |
| Deshacer el cambio de estilo | 1 | 4,7 | 1 (3,5) | **0** |

### Cocción en paralelo, fuera de latexmk

Como la cocción automática del `latexmkrc` no corre en esta máquina (ver hallazgo 1), se midió el script como lo usan el menú y las tareas de VS Code (`Herramientas\cocinar_figuras.ps1`, de a 16): se cambió `estilo_figuras.tex` y se cocinaron las 158 figuras nuevas.

| Paso | Tiempo |
|---|---|
| `cocinar_figuras.ps1`: listado (7 s) + cocción de 158 figuras | **105 s** de cocción, 113,9 s de reloj |
| Parcial después de cocinar | 5,0 s |
| Parcial al deshacer el cambio de estilo (0 figuras recocinadas) | 4,9 s |

Referencia del README: ~45 s con 12 trabajos en la máquina del autor, contra ~4,5 min de a una.

## Hallazgos

1. **La cocción en paralelo automática del `latexmkrc` de inspo falla siempre acá.** Las tres veces que se disparó (parcial en frío, cambio de estilo y la pasada siguiente) dejó `cocción en paralelo: 0.0 s ... FALLÓ` en el registro y pgf cocinó las figuras de a una (~4 s cada una en el parcial, ~5,3 s en el rápido). Causa verificada: dentro de latexmk el `PATH` de Perl tiene **una sola entrada, el `bin` de MiKTeX** (sin `System32` ni `WindowsPowerShell`). `system('powershell', ...)` no lo encuentra, Perl cae a `cmd.exe`, que tampoco encuentra, y da `Can't spawn "cmd.exe"`. Con la ruta absoluta de `powershell.exe` anda. Fuera de latexmk el `PATH` está bien. Quién lo recorta (el lanzador de MiKTeX 26.5 o latexmk 4.88) no se verificó. Efecto colateral: en el mismo `latexmkrc`, el `tasklist` del registro (detección de otros `pdflatex`) también corre sin `PATH`. Para el diseño: cualquier cosa que una regla de `latexmkrc` lance por nombre y no esté en el `bin` de MiKTeX falla en silencio; la app lanza ella las subcompilaciones (fila 9 de la tabla del plan) y el doctor tiene que detectar esto.
2. **Disparo de la cocción.** Con una cocción parcial hecha (46 de 158 figuras del sello nuevo, menos del 60 % de las del sello anterior), el `latexmkrc` vuelve a intentar la cocción en cada build hasta que el cache llega al 60 %. Se vio: la pasada que siguió al cambio de estilo volvió a disparar y a fallar en 0,0 s. Con la cocción andando sería un costo por guardado hasta completar el cache.
3. **Los tiempos de esta máquina son peores que los del README.** Parcial 4,7 s (README ~3 s), rápido 9,4 s (~6,5 a 7 s), completo 338,5 s (~40 a 70 s: cada pasada son ~82 s, sin cache de figuras), cocción en paralelo 105 s (~45 s). No se midió si Defender u otra cosa influye. Los objetivos de aceptación del plan (parcial ≤ 3,5 s, rápido ≤ 8 s, cambio de estilo en ≤ 60 s) quedan por debajo de lo que logran hoy los scripts de inspo acá; ver `plan.md`, sección F2 y F6.
4. **Alternar parcial ↔ rápido cuesta 0 pasadas con el esquema de inspo**, porque `libro_fast` trae los capítulos por `\input` y no escribe los `.aux` de capítulo. Es el listón que tiene que igualar el aislamiento de `.aux` de S1.
5. **El rápido se enlentece con el uso** (cambio chico: 9,1 → 9,4 → 9,8 s en tres repeticiones seguidas; el parcial queda plano en 4,7 a 4,8 s). Con tres puntos no alcanza para decir más; se vuelve a mirar en F2.
6. **Un cambio de estilo recocina sólo lo que el build necesita.** En el parcial son las 46 figuras del capítulo de trabajo (183 s de a una); las otras 112 esperan al primer rápido o a una cocción explícita. Deshacer el cambio no recocina nada (0 figuras, 4,7 s): el cache indexado por sello funciona como dice el README.

## F1: esqueleto de la app

Mismas máquina y versiones que arriba. El build "completo" es el del perfil `completo` con el esquema A de S1 (driver en `.lv/drivers/`, salida en `.lv/build/completo/`), sobre una copia del libro en frío.

### Build completo con el esquema A, contra la línea de base

| Medición | Tiempo | Pasadas |
|---|---|---|
| Línea de base de inspo (`compilar.ps1 -Que completo`, limpio) | 338,5 s | 4 (~82 s cada una) |
| Paso 0: script de Node (`spikes/f1-completo-a/run.mjs`), en frío | 346,8 s | 4 |
| `lv-core` por el ejemplo de consola (`--example build`), en frío | 340,6 s | |
| App, smoke de aceptación (primera corrida), en frío | 316,8 s | |
| App, smoke de aceptación (corrida final), en frío | 320,6 s | |
| Paso 0: sin cambios | 0,7 s | 0 |
| Paso 0: cambio chico en `Desnormalización.tex`, auxiliares tibios | 87,1 s | 1 |

El esquema A no cambia el tiempo del completo: las cuatro corridas en frío dan entre 317 y 347 s contra 338,5 s de la línea de base (la variación entre corridas es de ese orden). Con el cambio chico, una pasada del completo (87 s) es lo que ya costaba una pasada en inspo (~82 s).

El resultado también es el mismo: 194 páginas, 0 referencias sin resolver, índice y bibliografía generados, `.aux` de los 8 capítulos en `.lv/build/completo/Secciones/` y ninguno suelto en la raíz del proyecto, y un PDF de 4.134.501 bytes igual al de la línea de base.

### Operaciones de la app sobre el libro

Medidas por el smoke de aceptación dentro de la app real (`scripts/aceptacion-f1.ps1 -Proyecto libro-tc`), con `Secciones/Desnormalización.tex` (201 KB, 3966 líneas).

| Operación | Tiempo |
|---|---|
| Abrir el archivo en una pestaña (leer, decodificar, armar el estado de CodeMirror) | 42 a 51 ms |
| Editar, guardar con escritura atómica y comparar los bytes de disco | 33 a 36 ms |
| Guardado sin cambios (el core no escribe; incluye 50 ms de espera del test) | 71 a 81 ms |
| Cargar el PDF de 194 páginas y pintar las páginas visibles | 0,2 s |
| Buscar un texto en las 194 páginas (`getTextContent` de todas) | 0,52 a 0,53 s |
| Zoom más, zoom menos ×2, ajustar al ancho, ir a la página 3, siguiente, anterior y esperar el pintado | 0,22 s |
| Arranque de la interfaz hasta tener el proyecto abierto | 442 ms con el libro; 158 a 162 ms con un fixture chico |
| Memoria del árbol de procesos (WebView2 incluido) con el PDF de 194 páginas cargado | 505 MB (447 MB con un PDF de una página) |

La app vacía ocupaba 327 a 344 MB en S3, así que el PDF del libro suma unos 160 MB. Es una sola medición por caso, tomada con la interfaz quieta al terminar el smoke: no se midió el uso con varios builds seguidos (eso es F2, junto con el swap del visor).

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 39 | EOL y BOM (12 casos de bytes), rutas maliciosas, versión y conflicto, escritura atómica con el archivo abierto por otro, proyecto, y el runner del build con un latexmk falso (bytes inválidos, inundación de stderr, cancelar mata el árbol, ocupado, ok y no ok) |
| `cargo test -p lv-core --features tex` | +4 | build completo con TeX real de fixtures en una carpeta con espacios y `ñ`, `\include` en subcarpetas con tildes, índice con `-s StyleInd.ist` y bibliografía (regresión de `INDEXSTYLE`), build sin cambios |
| `npx vitest run` | 32 | store (abrir, editar, guardar mientras se escribe, conflicto, EOL mezclados, cerrar, compilar, eventos del build, cierre de la ventana) y buffer del log |
| Smoke dentro de la app | 3 proyectos | `libro-tc` (LF), `libro-include` (CRLF, rutas con tildes), `articulo-simple`: bytes exactos al guardar y al revertir, F5/Ctrl+R/Ctrl+P frenados, Ctrl+S por evento real, build, PDF visible, marcador en el texto del PDF, zoom y navegación |

### Hallazgo del paso 0

El completo con el esquema A tal como lo dejó S1 **falló**: latexmk corre makeindex desde el directorio de salida y el `$makeindex = 'makeindex -s StyleInd.ist ...'` del libro nombra su estilo relativo a la raíz ("Index style file StyleInd.ist not found", código 12, 532 referencias sin resolver, sin índice ni bibliografía). S1 no lo vio porque ni el parcial ni el rápido llevan índice. Se corrige con `INDEXSTYLE` apuntando a la raíz en `.lv/latexmkrc`; se probaron dos correcciones en `fixtures/biblio-indice` (`INDEXSTYLE`, y reescribir el `-s` del `$makeindex` a ruta absoluta) y las dos funcionan; se eligió la primera porque también cubre estilos en subcarpetas y no toca el `$makeindex` del usuario. Con la corrección, el resultado de la tabla de arriba. Ver `docs/spikes/S1.md` y 5.1 del plan.
## F2: motor de compilación y perfiles

Todo medido por el smoke de aceptación dentro de la app real (`scripts/aceptacion-f2.ps1`), sobre una copia **tibia** del libro (790 figuras del sello actual en `figuras-cache/`, ningún `.aux`, con `fixtures/configs/libro-tc.latexviewer.json`), tres corridas completas con los mismos resultados dentro del ruido. Entre paréntesis, lo que dan los scripts de inspo (línea de base de arriba) y lo que midió S1 con el esquema A.

### Criterios de aceptación de F2 (umbrales de esta máquina, ver el ajuste en plan.md)

| Criterio | Umbral | Medido | inspo / S1 |
|---|---|---|---|
| Parcial, de Ctrl+S a PDF visible | ≤ 5,0 s | **4,93 s** (latexmk 4,63 a 4,73 s, 1 pasada) | 4,7 s / 4,5 a 5,0 s |
| Rápido, de Ctrl+S a PDF visible | ≤ 9,6 s | **9,25 s** (latexmk 8,84 a 8,90 s, 1 pasada) | 9,4 s / 8,4 a 9,6 s |
| latexmk sin cambios | ≤ 1 s y 0 pasadas | **0,59 a 0,60 s**, 0 pasadas | 0,6 s |
| Alternar parcial, rápido, parcial, rápido | 0 pasadas | **0, 0, 0, 0** | 0 |
| Referencias a capítulos excluidos en el parcial | resueltas | **0 sin resolver** (`.log` de la última pasada) | |

El parcial queda 0,2 s por encima de latexmk a secas porque el tiempo es de punta a punta: guardar, preguntar al core qué afecta, lanzar, leer el PDF y pintar lo visible (0,2 a 0,3 s). Está en el borde del umbral: una máquina más cargada lo puede pasar, y por eso el smoke lo muestra con su margen.

### Los demás tiempos

| Escenario | Tiempo | Pasadas |
|---|---|---|
| Rápido con auxiliares limpios (cache de figuras tibio) | 37,5 a 38,4 s | 4 |
| Parcial con los `.aux` sembrados desde el rápido | 14,9 a 15,0 s | 3 |
| Índice de inclusión y partes del libro (50 `.tex`, 8 partes) | **8 a 9 ms** (objetivo: < 1 s) | |
| Cuatro pedidos de build seguidos con uno corriendo | 2 builds (el primero y UN pendiente) | |
| Cancelar con un pendiente: no corre el pendiente y el siguiente build sale bien | 8,8 a 9,0 s, 1 pasada, sin reparar | |
| Procesos de TeX vivos al cerrar la app | 0 | |

### Recarga del PDF sin parpadeo (swap de dos visores)

Rápido de 183 a 194 páginas, 40 recargas seguidas con el visor en la página 60 (la medición de S3, ahora en el visor de la app):

| | Medido | S3 |
|---|---|---|
| Cuadros en blanco | **0 de 490** | 0 en más de 130 recargas |
| Deriva de posición | **0 páginas, 0 px** | 0 |
| Hasta lo visible | hasta 227 a 241 ms | 220 a 230 ms |
| Visores armados al terminar | 1 | |
| Memoria del WebView (antes, a 1/4, 1/2 y 3/4 de las recargas, pico, después) | 545, 641, 661, 662 MB, pico 679, **después 672 MB** | ~0,7 GB estable con el desarmado completo |

Sube en el primer cuarto (PDF.js arma su caché y su worker) y después queda plana: es lo que S3 llamó estable (sin el desarmado completo eran +33 MB por recarga, 1,3 GB a las 40).

### Regresión de F1 con el motor nuevo

El smoke de F1 (`scripts/aceptacion-f1.ps1`) sigue pasando en los tres proyectos con el motor de F2. Sobre el libro: completo en frío 307,4 s (F1: 317 a 347 s, línea de base 338,5 s), 194 páginas, marcador en la página 143, arranque hasta proyecto abierto 410 ms.

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 84 | lo de F1 (39) más: configuración (`latexviewer.json` con campos desconocidos, BOM, JSON roto, estado ilegible, `.gitignore` sin cambiar el EOL), grafo de inclusión y partes (comentarios, `\%`, llaves, tildes, parámetros de macro, ciclos, `\Capitulo` dentro de un archivo que entra por `\input`), auxiliares (sembrado, sospechoso, `.md5`, reparación), driver con flags y variables, contador de pasadas con agujas partidas entre fragmentos, y la sesión con un latexmk falso: cola y coalescencia, cancelar descarta el pendiente, reparación de `.aux` truncado una sola vez, publicar, estado |
| `cargo test -p lv-core --features tex` | +5 | lo de F1 (4) más la sesión con TeX real: parcial y rápido alternando sin pasadas extra y con las referencias a la parte excluida resueltas |
| `npx vitest run` | 54 | lo de F1 (32) más perfiles y partes, auto-compilación (al guardar, al dejar de tipear con relojes falsos, manual, archivo de otra parte con las tres políticas) y los eventos nuevos del build (cola, reintento, PDF desactualizado) |
| Smoke de F2 dentro de la app | 16 pasos | los de la tabla de arriba, más: guardar un archivo de una parte que el perfil no incluye avisa y no compila, y publicar |

### Hallazgos de F2

- **`.fls` no sirve para saber qué compiló un parcial**: `\include` abre los `.tex` de las partes excluidas para comprobar que existen. Se miró la cantidad de páginas del log.
- **El smoke de F2 tuvo una carrera propia que lo colgó**: cuando sube `pdfEpoch`, el visor todavía muestra el PDF viejo (con sus páginas pintadas y un solo contenedor), así que "PDF visible" se daba por cumplido antes de tiempo y la búsqueda del marcador corría contra un documento que el swap destruía a mitad de camino. Ahora el host guarda la etiqueta del último PDF cargado (`<ruta>#<época>`) y el smoke espera a que coincida con la del store; `paginaConTexto` además aborta si el visor cambia.

## F3: errores y avisos

### El parser sobre logs reales

Medido con el ejemplo `cargo run --release -p lv-core --example problemas`, tres corridas.

| Log | Tamaño | Tiempo | Problemas |
|---|---|---|---|
| Rápido del libro (`.lv/build/rapido/lv-rapido.log`, 2706 líneas) | 127 KB | **4,1 a 4,3 ms** | 0 errores, 0 avisos, **51 cajas mal llenas** (un `grep` de `^(Overfull|Underfull) ` del log da 51) |
| `fixtures/logs/errores.log` (un pasada con errores) | 17,8 KB | ~1 ms | 2 errores, 5 avisos, 1 caja mal llena |

El libro está limpio de errores y avisos; lo único que hay son cajas mal llenas (51, de las que sólo 4 tienen línea; las otras son `\vbox ... while \output is active` y no se pueden ubicar). Hay que recordar que el parser corre una vez por build, así que 4 ms no pesan.

### Smoke de aceptación de F3 (dentro de la app real)

`scripts/aceptacion-f3.ps1` sobre `fixtures/errores`, 10 pasos, unos 14 s en total (casi todo es el build con errores, 3,0 s, y el siguiente tras arreglar, 6,7 s por biber): conteo del log en el `Finished`, panel abierto solo, clic que abre el archivo en su línea, gutter en las líneas 2 y 4, F8 y Mayús+F8 con eventos de teclado reales dando la vuelta, filtro de cajas mal llenas, marcas que bajan una línea cuando se inserta una arriba (11 y 16 pasan a 12 y 17), arreglo con el error de biber que queda (`refs.bib:10`) y archivo faltante con su línea (`faltante.tex:5`).

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 96 | lo de F2 (84) más el parser (11: logs reales, atribución del overfull al archivo que se cerró, resúmenes descartados, biber y makeindex, bytes inválidos y rutas con espacios y paréntesis sueltos, errores sin `file-line-error`, deduplicación) y el conteo en el `Finished` de la sesión |
| `cargo test -p lv-core --features tex` | +5 | sin cambios |
| `npx vitest run` | 69 | lo de F2 (54) más filtro, F8, marcas por archivo, resumen, el campo de CodeMirror (las marcas siguen a las ediciones) y el store de problemas |

### Hallazgos de F3

- **Los `Info` de LaTeX no terminan en una línea en blanco**: la versión que saltaba cada bloque de mensaje hasta la línea en blanco se tragaba el `)` que cierra un archivo y desalineaba la pila (todos los avisos quedaban sin archivo). Los `Info` son ahora la línea más sus continuaciones `(paquete)`.
- **latexmk no corre biber ni makeindex con errores de LaTeX**: sus problemas aparecen recién cuando los de LaTeX están resueltos (ver 5.8).
- **Un nombre de módulo `aux` no se puede versionar en Windows** (nombre reservado): se descubrió al commitear F2 y se renombró a `auxiliares`.
- Una captura de pantalla de la ventana para revisar el aspecto tomó el programa que estaba encima y no la app: se borró de inmediato y quedó escrito en `CLAUDE.md` que no se hacen capturas ni se mueve el mouse para probar.

## F4: SyncTeX

### Criterio de aceptación del plan, sobre el libro

`scripts/aceptacion-f4.ps1` (dentro de la app real): compila el rápido (183 páginas), elige **50 párrafos largos al azar** de las 8 partes (semilla fija; hay 181 candidatos de al menos 300 caracteres y 40 palabras en una sola línea fuente), toma una palabra al azar de al menos 4 letras de cada uno y recorre el camino que usa el usuario. Cuatro corridas iguales.

| Criterio | Umbral | Medido |
|---|---|---|
| Forward: el resaltado cae en la palabra elegida | ≥ 90 % | **49/50** (98 %) |
| Inverse, desde el centro de ese resaltado: el cursor queda a ≤ 1 palabra y en la misma línea | ≥ 90 % | **49/50** (98 %) |
| Tiempo de cada salto (core + capa de texto + búsqueda) | ≤ 150 ms | mediana **7 a 8 ms**, p95 **14 a 18 ms**, máximo **50 a 54 ms** (el máximo es el primer salto, que carga el SyncTeX del libro: ~45 ms) |
| El resaltado coincide con las letras que se ven (capa de texto de PDF.js, 10 muestras) | | 9/10 |
| Un doble clic real (evento del DOM) sobre el resaltado lleva a la misma palabra del fuente | | 5/5 |

La única falla de las 50 es una palabra ("mismo", en `Aproximación de Cauer.tex:1705`) de un párrafo con matemática en casi cada frase: el forward no la encontró entre las palabras de las cajas y cayó en las cajas de la línea (que es lo que hace cualquier SyncTeX), y el inverse del paso siguiente no se midió.

### El parser propio contra el CLI como oráculo

`cargo test -p lv-core --features tex --test synctex_oraculo`, sobre un PDF que compila el propio motor (`fixtures/sync`: 9 párrafos largos, una ecuación display, una tabla, una nota al pie y una lista):

| | Resultado |
|---|---|
| Forward en párrafos: mismas páginas que el CLI / la primera caja del CLI está entre las propias (±2 bp) | **9/9** y **9/9** |
| Inverse, ida y vuelta por tres puntos de cada párrafo: misma línea y mismo archivo que el CLI | **27/27** |
| Forward en líneas especiales (ecuación, tabla, nota al pie, `\item`): la primera caja coincide | 6/6 (S2 había medido desacuerdos en figuras y ecuaciones con el libro; en este fixture no aparecen) |

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 106 | lo de F3 (96) más el parser de SyncTeX (7: `Input:` a mitad del contenido, rutas del driver y de afuera, hijos contra caja de párrafo, registros `x`, cajas de tamaño cero, gz de verdad y roto, archivo cortado) y la sesión (elección del PDF por especificidad con las tres reglas, ida y vuelta con rutas relativas, invalidación del cache por mtime) |
| `cargo test -p lv-core --features tex` | +7 | los 5 de antes más los 2 del oráculo |
| `npx vitest run` | 96 | lo de F3 (69) más texto plano con el mapa de offsets (18 pruebas de la búsqueda: palabras repetidas, guiones al final de línea, matemática, tolerancia de una letra) y el store de SyncTeX (cambio de PDF, silencioso, seguir al cursor con relojes falsos) |

### Hallazgos de F4

- **`irA` se aplicaba de nuevo al volver a una pestaña**: el pedido de "ir a esta línea" quedaba en el store y el editor lo repetía cada vez que esa pestaña volvía a estar activa, moviendo el cursor. Lo encontró el smoke (el forward salía de una posición vieja). Ahora cada pedido se atiende una sola vez (`n`).
- **El smoke también tuvo una carrera propia**: asignar `doc.state` por la espalda de la vista dejaba a CodeMirror con el cursor viejo; ahora el cursor se mueve con `moverCursor`, que pasa por la vista como lo haría el usuario.
- **PDF.js restaura "la página actual" al cambiar el tamaño del panel**: `mostrar` le dice primero cuál es la página (`currentPageNumber`) y después ajusta el desplazamiento fino.
- **Una caja con alto pero sin ancho** (un puntal, una regla de ancho cero) no sirve para resaltar: el forward la reemplaza por la contenedora que tiene los dos tamaños.
- **El tiempo absoluto de F2 depende de la carga de la máquina**: con otro proceso ocupando CPU, el parcial pasó de 4,6 a 4,9 s de latexmk y el rápido de 8,9 a 10,9 s. El smoke de F2 ahora falla por lo que la app agrega a latexmk (312 a 442 ms con el libro; límite 700 ms) y sólo informa el umbral absoluto de 5,0 y 9,6 s.

## F5: editor y navegación

### Índice del proyecto y búsqueda, sobre el libro

`cargo run --release -p lv-core --example simbolos -- fixtures/libro-tc --search <texto>`, con el `latexviewer.json` del libro (38 `.tex` alcanzados, 154 archivos de texto en el árbol). Cinco corridas del índice, tres de cada búsqueda.

| | Medido | Criterio |
|---|---|---|
| Grafo de inclusión (ya existía en F2) | 8,6 a 10,9 ms | |
| Índice de símbolos: 602 etiquetas, 465 `ref`, 17 citas, 19 entradas de `.bib`, 198 secciones, 501 definiciones, 124 archivos, lint | **13,1 a 14,8 ms** | < 1 s |
| Problemas de lint sobre el libro | **0** | el libro compila limpio: sin falsos positivos |
| Búsqueda literal (`aproximación`, 179 coincidencias en 22 archivos del grafo) | 15,6 a 16,7 ms | |
| Búsqueda con regex (`ref` y `eqref`, 545 coincidencias en 21 archivos) | 16,0 a 17,1 ms | |
| Lo mismo sobre todo el árbol (154 archivos leídos) | 71 a 80 ms; **1,4 s la primera vez** (el sistema todavía no tenía los archivos en memoria) | |

### Smoke de aceptación de F5 (dentro de la app real)

`scripts/aceptacion-f5.ps1` sobre `fixtures/editor` (no compila, no necesita TeX): **16 pasos, 5 s en total**. Todo con eventos de teclado reales sobre el editor y el despachador de la ventana: formato (texto, matemática, comentar, `$…$`, `\emph`), autocompletado con el menú real de CodeMirror para `\ref{` y `\cite{`, F12 hacia etiqueta, clave y archivo con Alt+← y Alt+→, Shift+F12, Ctrl+P, paleta, Ctrl+Mayús+O y Ctrl+T, el panel Esquema, búsqueda comparada con el core, reemplazo con **bytes de disco exactos** y reversión byte a byte al original (con la pestaña limpia y con la pestaña modificada, que se guarda antes), lint en el gutter y `keybindings.json` (atajo nuevo, atajo quitado, comando inexistente avisado).

### Regresión con la interfaz nueva

F3, F4 y F1 (sobre el libro, 194 páginas, build completo ok) siguen pasando. El smoke de F3 falló una vez: el lint de F5 suma dos filas al panel de problemas de `fixtures/errores` (referencias sin etiqueta) y cuatro saltos más en F8; ahora el smoke de F3 apaga el filtro de lint, que tiene su propio smoke.

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 127 | lo de F4 (106) más los símbolos y el lint (etiquetas duplicadas, `ref` y citas rotas, entornos desbalanceados, comentarios, `%` escapado, llaves anidadas, claves de `.bib`) y la búsqueda y el reemplazo (regex, palabra, mayúsculas, columnas UTF-16, EOL y BOM, conflicto de versión) |
| `npx vitest run` | 177 | lo de F4 (96) más formato caso por caso (24), atajos y `keybindings.json` (13), filtro difuso (7), qué hay bajo el cursor y a dónde va F12 (10), fuentes de autocompletado (15) y el store de navegación y búsqueda (12: historial, F12, selectores, lint en F8, búsqueda lenta, reemplazo con confirmación) |

### Hallazgos de F5

- **El lint pasa a ser parte de F8 y del panel de problemas**: sin tocar los smokes anteriores habrían contado filas y saltos de más. Un filtro propio ("Lint") lo apaga.
- **El historial guarda el lugar actual con el cursor real**: al salir de un lugar con Alt+← se actualiza su línea con la del cursor, así Alt+→ vuelve adonde estabas y no adonde llegaste.
- **Ctrl+clic ya no agrega un cursor**: se usa para ir a la definición; el multicursor queda en Alt+clic.
- **Mientras hay un selector abierto el despachador no atiende atajos**: sólo frena los nativos (Ctrl+P y compañía). Sin eso, Ctrl+B o F8 actuaban sobre el editor que está atrás.

## F6: cache de figuras

Todo sobre `spikes/work/f6-libro` (copia tibia de `fixtures/libro-tc`, nunca `inspo/`), con `fixtures/configs/libro-tc.latexviewer.json` (modo `project`, sello de `estilo_figuras.tex`, `parallelJobs: auto`, 16 en esta máquina) y el motor de la app (`--example build`). Windows Defender con protección en tiempo real encendida y sus exclusiones sin tocar (no se pudo leer la lista sin ser administrador): los números ya incluyen al antivirus tal como está, y no se midió sin él.

### Criterios de aceptación del plan

| Criterio | Medido | Criterio |
|---|---|---|
| Cambio de `estilo_figuras.tex`, las 158 figuras | cocción **103,0 s** y **110,4 s** (dos corridas con 16 trabajos); con 159 figuras 115,8 s; más 7,6 a 9,5 s del listado | ≤ 105 s en esta máquina (la línea de base de inspo: 105 s + 7 s de listado). **Una de las tres corridas no llega, por un 5 a 10 %**; la dispersión entre corridas es de ese orden |
| Agregar una figura arriba del capítulo 1 (14 figuras en el archivo) | **15 cocidas** (las 14 del archivo, que corren de número, y la nueva), 10 s de cocción, 17,2 s con el listado | sólo las de ese archivo: ninguna de otro capítulo |
| Deshacer el cambio de estilo | **0 cocidas**, 8,1 s (todo es el listado) | no recocina nada |
| Parcial a la vista tras un cambio de estilo (sólo las 46 de `Desnormalización`) | **34,1 s** desde el cambio: 4,0 s de listado de las partes del perfil + 25,0 s cocinando sus 46 figuras + 5,0 s del build. El resto (112 figuras, 83,7 s de cocción + 8,2 s de listado) termina después: 118,2 s en total | en lo que tarda cocinar **sus** figuras (25 s) |
| Chequeo previo a cada build (sello + listado de la carpeta + regla del 60 %) | **6,06 ms** (promedio de 200 corridas, `--example figuras`, 1 152 figuras con PDF en el cache) | < 20 ms |
| Limpieza con el parcial activo | no borra figuras de partes que el parcial no incluye (`tests/figuras_sesion.rs`, con la lista del parcial y la completa) | no borra |
| Cancelar a mitad de una cocción | 209 ms hasta que el panel vuelve a quieto, 0 procesos de TeX vivos, ningún `.md5` sin PDF (smoke de F6 y tests con `pdflatex` falso y con TeX real) | sin figuras cortadas |
| Smoke de F2 (regresión) | ok; la app agrega 280 ms (parcial) y 404 ms (rápido) a latexmk, límite 700 ms | el cache no suma más de 20 ms por guardado: el chequeo mide 6 ms |

### Cocción de las 158 figuras según los trabajos en paralelo

Cada corrida cambia el sello (una línea de comentario en `estilo_figuras.tex` de la copia) y cocina de cero. `scripts/bench-figuras.ps1`.

| Trabajos | Cocción | Nota |
|---|---|---|
| 16 (núcleos lógicos) | **103,0 s** y **110,4 s** | el valor por omisión (`auto`) |
| 12 | ≈ 121 s | lo que usa el README del libro |
| 8 (núcleos físicos) | ≈ 157 s | |

Con 16 trabajos la máquina queda cargada: otros procesos hacen variar 5 a 10 % entre corridas.

### Listado y camino sin `-output-directory`

- El listado (una pasada de pdflatex con el perfil `cocina`, `mode=list and make`, sin dibujar) tarda 7 a 11 s en el libro entero y unos 4 s con las partes de un perfil parcial.
- El camino A (subcompilación sin `-output-directory`, cwd en la raíz, como la línea que arma pgf) se validó sobre el libro: no pisa los `.aux` de `\include` en paralelo y la raíz queda limpia (queda sólo el `run.xml` de biblatex, que la app borra al terminar). No hizo falta el plan B de un directorio por ranura.

### Smoke de aceptación de F6 (dentro de la app real)

`scripts/aceptacion-f6.ps1`, sobre una copia de `fixtures/figuras-app` (modo `app`, TeX real): **7 pasos, 25 s**. Cocinar con un clic real (4 figuras de 3 archivos, en paralelo), un build con el cache al día que no cocina ni lista, un cambio de estilo cuya cocción va antes del build con la barra de progreso a la vista, Limpiar con vista previa (16 archivos de 4 figuras, 0,1 MB) que sólo borra al confirmar, una figura rota (error en el panel y en los problemas, sin imagen vieja, y arreglarla lo limpia) y Cancelar a mitad de una cocción.

### Regresión

F1 (`articulo-simple`), F3, F4 (49/50 y 49/50, mediana 8 ms), F5 y F2 siguen pasando con la cola y la cocción. En F2: parcial guardado a PDF visible 5,3 s (latexmk 5,0 s), rápido 10,1 s (latexmk 9,7 s), las dos fuera del umbral absoluto que sólo se informa (ver F2: depende de la carga de la máquina) y dentro del límite de lo que agrega la app.

### Pruebas

| | Cantidad | Qué cubren |
|---|---|---|
| `cargo test -p lv-core` | 102 de biblioteca y 82 de integración con procesos falsos | la cola (7), el sello, la clasificación del cache, los pendientes por contenido, la limpieza, el cocinero con un pdflatex falso (máximo de paralelismo, falla que no corta, cancelar mata hijos), la inyección del modo `app`, la verificación de figuras, `ensure_cache_dirs` y `move_md5` con rename y las sesiones con cocción (orden, ceder el paso, disparo, cancelación, limpieza) |
| `cargo test -p lv-core --features tex` | todos pasan: 2 de la figura rota y 4 del modo `app`, más los de F1 a F4 con TeX real | la figura rota real (`\comandoQueNoExiste`: reproducida con MiKTeX antes de arreglarla), la cancelación con TeX real y el modo `app` sobre `fixtures/figuras-app` |
| `npx vitest run` | 192 | lo de F5 (177) más el store de figuras y el filtro por archivo del panel |

### Hallazgos de F6

- **pgf escribe el `.md5` antes de lanzar la subcompilación de la figura.** Una figura con un comando inexistente sale con código 0, sin error en el log principal, con el PDF viejo y con el md5 nuevo, y el build siguiente no reintenta. Es el caso de la revisión; se reprodujo con MiKTeX como test (`tests/figuras_rotas.rs`) antes de arreglarlo.
- **latexmk no cuenta como cambio un archivo de figura borrado**: para que el build siguiente reintente hay que borrar también el `.fdb_latexmk` del perfil.
- **Los logs de las subcompilaciones de figuras salen cortados a 79 columnas**: el archivo y la línea del error se reconstruyen desarrollando el log (`figures::desenvolver`).
- **El parcial se ve mucho antes que el resto**: 34 s contra 118 s para dejar todo el cache al día. Sin partir la cocción en "las del perfil" y "el resto" el primer build habría esperado ~125 s.
- **Cada cocción del resto repetía un listado de 8 s** aunque el perfil fuera de todas las partes (el listado del perfil ya era el del documento): al cierre de F6 el perfil con todas las partes no pide la continuación `Todo` (test `un_perfil_de_todas_las_partes_no_pide_un_segundo_listado_del_resto`).
- **Un perfil que sólo consume el cache** hace el completo del libro en 36 s contra 330 s (9 s con un cambio de texto); el diff rasterizado contra el completo sin cache no da cero (89 de 198 páginas, 0,03 % de los píxeles) pero la paginación y el texto por página coinciden. Decisión de Juan: `completo` con cache para revisar (no publica) y `entrega` sin cache para publicar (spike S5, `docs/spikes/S5.md`).

### Cierre de F6, después de S5

Sobre `spikes/work/f6-libro` con el `latexviewer.json` nuevo (`completo` con `cacheOnly`, `entrega`).

| Escenario del `completo` con cache | latexmk | Reloj del proceso | Objetivo |
|---|---|---|---|
| Sin cambios (dos corridas) | 0,6 s | **1,1 s** (con ~0,4 s de arranque del ejemplo) | ≤ 1 s |
| Cambio de texto en un capítulo (dos corridas) | 9,1 y 9,0 s | **9,6 y 9,5 s** | ≈ 9 s |
| Una figura editada: listado + 1 figura + build | 9,1 s | 22,1 s (7,4 + 12,4 de cocción + 9,1) | |
| Comprobación para saltear el listado (grafo + huella + PDF de la figlist) | | **28 ms** | |

**Archivos que una figura lee desde adentro de su `tikzpicture`** (`\input`, imágenes, `plot file`), sobre el libro: el grafo encuentra 3 (los 2 engranajes del anexo de Cauer, dentro de un `figure`, y una imagen del template, fuera de uno, que no invalida nada). Correr `gen_engranajes.py` con otro ángulo de presión: cocina 2 de 159 figuras (14,4 s de cocción + 7,8 s de listado) y cambia 1 página de 198 (852 píxeles). Sin cambios: 1,2 s. Con TeX real el test de `fixtures/figuras-datos` da 0 subcompilaciones sin la invalidación y 1 con ella. La comprobación para saltear el listado pasó de 28 a 33 ms (el grafo cuenta `\begin`/`\end`). Detalle en `docs/spikes/S5.md`.

**Limpieza del cache** (el comando Limpiar del panel, desde `--example build -- <carpeta> --limpiar`): sobre la copia, 5 769 archivos de 1 455 figuras de sellos viejos (los de los benchmarks), 261,1 MB; quedan las 159 del sello de hoy (27,9 MB).

**El smoke de F2 con la máquina quieta** (CPU 3 a 12 % antes de empezar, dos corridas seguidas, cache limpio): parcial 5,4 y 5,2 s de guardar a PDF visible (latexmk 5,0 y 4,9 s), rápido 10,2 y 9,9 s (latexmk 9,7 y 9,5 s). Antes de F6 había dado 4,93 y 9,25 s. Para descartar una regresión del motor se corrió el mismo escenario (cambio de una palabra en un capítulo) con el ejemplo `build` de F5 (`9c6ed40`, en un worktree aparte) y con el de F6, **intercalados**, seis veces cada uno sobre la misma copia, midiendo el tiempo que informa el motor:

| Perfil | Motor de F5 (s) | Motor de F6 (s) |
|---|---|---|
| Parcial | 4,6 4,7 4,6 4,6 4,7 4,7 (mediana **4,70**) | 4,7 4,7 4,6 4,7 4,7 4,7 (mediana **4,70**) |
| Rápido | 9,2 8,8 9,8 8,8 8,8 9,1 (mediana **9,10**) | 8,8 8,8 8,9 8,8 9,4 9,2 (mediana **8,90**) |

Iguales. La diferencia con las cifras de antes es de la máquina (el parcial hoy da 4,7 s en los dos motores; 4,9 a 5,0 s dentro de la app, que suma 313 a 467 ms: en el rango de los 312 a 442 ms de F2). No es una regresión de F6.
