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
