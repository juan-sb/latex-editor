# F9: paridad con el esquema de inspo

Qué hacía el libro (`Menu.bat`, las tareas de VS Code y los scripts de `Herramientas/`) y dónde está ahora en LaTeX Viewer 2, con cómo se verificó. El libro **convive** con los dos esquemas (el viejo sigue andando; el retiro espera el OK de Juan).

Todo se midió sobre copias del libro en `spikes/work/` (la del esquema viejo sale de `pre-f9`; la de la app lleva además el `latexviewer.json` y el `structure.tex` de F9). `inspo/` no se compiló.

## Lo que se miró

- **`latexviewer.json`: la detección llegó sola.** `cargo run --release -p lv-core --example detectar -- inspo/Proyecto --json` (el mismo código que usa la pantalla Proyecto; el smoke de F8b prueba que la pantalla escribe exactamente eso) dio una configuración **equivalente** a `fixtures/configs/libro-tc.latexviewer.json` (`scripts/comparar-config.py`): perfiles `parcial`, `rapido`, `completo` y `entrega`, `publish` a `../PDF` con el nombre «Funciones de Aproximación.pdf», `export` a `../PDF/Capítulos` y la variable `OpcionPie` con sus tres opciones. **No hubo que corregir nada a mano: cero defectos de la detección.** No se manejó la pantalla con el mouse (regla del repo): conviene que Juan abra la pantalla Proyecto sobre el libro y compruebe que muestra lo mismo.
- **`structure.tex`**: el default de `\OpcionPie` con guardia y `\InputIfFileExists{opciones}` sólo cuando no compila la app (`\lvPerfil` lo define el driver). El doctor lo comprueba: «Las variables del proyecto tienen su valor por omisión con guardia».
- **Lo viejo sigue igual** (`Herramientas/compilar.ps1` sobre dos copias, una de `pre-f9` y otra con el cambio de F9; raster a 60 dpi con `scripts/comparar-pdf.py` y texto con `pdftotext`):

  | | páginas | distintas | texto | tiempo |
  |---|---|---|---|---|
  | `capitulo` (cap_actual) | 48 | 0 | idéntico | 6 s las dos |
  | `rapido` (libro_fast) | 183 | 0 | idéntico | 12 y 11 s |
  | `completo` | 194 | 0 | idéntico | 341 y 350 s |

- **El doctor sobre el libro** (12 sondas, 2,1 s): todo en orden salvo el aviso «Dentro de latexmk el PATH tiene 1 entrada», que es del `latexmkrc` del libro (se reduce en el retiro).

## PDF idénticos (la app contra el esquema viejo)

Perfiles de la app construidos con el ejemplo `build` (el mismo motor), contra los PDF del esquema viejo, con el cache de figuras tibio en las dos:

| App | Esquema viejo | páginas | distintas | texto | tiempo de la app |
|---|---|---|---|---|---|
| `parcial` (Desnormalización) | `cap_actual` | 48 y 48 | 0 | idéntico | 9,4 s (2 pasadas) |
| `rapido` | `libro_fast` | 183 y 183 | 0 | idéntico | 42 s con los `.aux` fríos |
| `entrega` (sin cache) | libro completo (`compilar.ps1 -Que completo`) | 194 y 194 | 0 | idéntico | 367 s (el viejo, 340 s) |
| exportar todas (8 capítulos, pie «completo») | `exportar_capitulo.ps1` | las 8 con los mismos nombres («08 - Funciones de Aproximación.pdf» a «15 - Desnormalización.pdf») | 0 en las 8 | idéntico en las 8 | 127 s (el viejo, 126 s) |

Observación sobre el parcial **en frío**: sin ningún `.aux` de las otras partes (primera vez que se compila el libro), el parcial numera el capítulo como 8 y no como 15, y no hay hoja en blanco de apertura. Con los `.aux` de otra compilación (la del completo, el rápido o la entrega) el parcial sale idéntico al viejo, que es como lo usa el autor, que siempre los tiene. La app los siembra (`docs/spikes/S1.md`); el primer build de un proyecto nuevo no los tiene y ningún esquema puede inventarlos.

**Corregido después (0.9.1): sembrado de último recurso.** Si ningún perfil tiene el `.aux` de una parte, el parcial lo siembra de la cocina (`.lv/build/cocina/`, que el listado de una cocción compila entera) y de la exportación, siempre que ese build no sea sospechoso. El listado de la cocina ahora lleva su marcador `.sospechoso` (se pone antes y se saca sólo si el motor termina con código 0). La paginación de la cocina no es la definitiva, pero la numeración y las etiquetas sí. Medido sobre una copia del libro sin ningún `.aux`: una cocción y un parcial con Desnormalización dan «15. Desnormalización», 48 páginas, 0 distintas y el mismo texto que el `cap_actual.pdf` viejo. Sin ninguna cocción ni build previo sigue saliendo 8: no hay de dónde sacar el número.

## Tabla de equivalencias

`Menu.bat` (opciones 1 a 8, mantenimiento y abrir) y las tareas de VS Code (Ctrl+Alt+T, 0 a 9):

| Antes | Ahora | Verificado |
|---|---|---|
| **1** Elegir el capítulo de trabajo (`Set-CapituloDeTrabajo`, reescribe el `\includeonly` de `cap_actual`) | Panel **Partes**: tildar las partes; perfil `parcial` («Partes elegidas»). O abrir un archivo y **Ctrl+Alt+C** (compila la parte del archivo abierto, aunque sea un `fig_*.tex`: el grafo de inclusión lo resuelve) | F2 (perfiles, selección), F8b, esta comparación |
| **2** Compilar el capítulo de trabajo (`cap_actual.pdf`, ~3 s) | Perfil `parcial` + **Ctrl+Enter** | PDF idéntico (arriba); 9,4 s |
| **3** Compilar el libro rápido (`libro_fast.pdf`) | Perfil `rapido` + Ctrl+Enter | PDF idéntico |
| **4** Qué compila Ctrl+S (capítulo o rápido) y tareas 1 y 2 | **Auto-compilación** (al guardar / al dejar de escribir / manual) y el **selector de perfil** de la barra: lo que compila el guardado es el perfil activo. La tarea 0 (rápido una vez sin tocar el guardado) es elegir `rapido` y Ctrl+Enter | F2 y F8 (guardar dispara un build con el motivo) |
| **5** Compilar el libro completo (sin cache, ~70 s a 6 min según la máquina) y tarea 3 | Perfil `entrega` (sin cache, `cleanBefore`). `completo` queda para revisar con el cache (`cacheOnly`) | PDF idéntico |
| «Publicar» a mano en `../PDF` | **Publicar** (menú de compilación): copia el PDF de `entrega` a `../PDF/Funciones de Aproximación.pdf` con su `.synctex.gz`, y se niega con un build en borrador | F2, F8c |
| **6** Exportar un capítulo y tarea 4 | **Exportar la parte del archivo abierto** / **las partes elegidas** (menú de compilación y paleta), a `../PDF/Capítulos/NN - nombre.pdf` con el número impreso | F7 (dos partes, 8 y 9) |
| **7** Exportar todos los capítulos y tarea 5 | **Exportar todas las partes** | las 8 iguales (arriba) |
| **8** Pie de página (completo / autor / ninguno) y tarea 6 | Variable **Pie de página** (`OpcionPie`) del menú de compilación, con `structure.tex` con guardia | F7 (parcial con y sin pie) y doctor |
| **C** Cocinar el cache de figuras y tarea 7 | Panel **Figuras** › Cocinar (en paralelo, con progreso); se dispara solo al cambiar el estilo y antes de un build al que le falten | F6 y F8b |
| **L** Limpiar el cache viejo y tarea 8 | Panel **Figuras** › Limpiar, con vista previa de lo que borra | F6 |
| **P** Abrir la carpeta PDF | **Abrir la carpeta de los PDF publicados / exportados** (menú de compilación y paleta). **No existía en la app: lo agregó F9** (`Session::carpeta_de_salida` crea la carpeta si falta, como la opción del menú, y la abre en el explorador de archivos) | test del core y de Vitest; la ventana del explorador no se abre en los smokes |
| **V** Abrir el proyecto en VS Code | No aplica: la app es el editor. El libro se puede seguir abriendo en VS Code mientras convive el esquema viejo | n/a |
| **H** Ayuda (README) | `README.md` del libro, `INSTALAR.md` y la pantalla Proyecto (explica qué detectó) | n/a |
| Tarea 9 «muestra el estado» | Barra superior (perfil, partes, pasada y herramienta, tiempo y típico), panel **Historial** (por qué tardó cada build) y **Doctor** | F8, F8b |
| Ctrl+Alt+J (SyncTeX al PDF que corresponde) | **Ctrl+Alt+J**, el botón ▶ sobre la barra entre editor y PDF, y doble clic o Ctrl+clic en el PDF para volver | F4 (posición medida contra las letras: 0,12 bp de mediana) |
| `registro-compilacion.txt` (por qué tardó) | Historial estructurado (`.lv/history.jsonl`) con las pistas | F8 |
| `tasklist \| findstr pdflatex` (un `pdflatex` colgado) | Aviso de procesos que quedaron de antes al abrir, y Job Objects para matar el árbol entero | F8 |

## Lo que cambia para el autor

- Los PDF de trabajo de la app quedan en `.lv/build/<perfil>/` (no en `../PDF`): lo que se entrega es **Publicar**. Mientras convivan, `compilar.ps1` sigue dejando `cap_actual.pdf`, `libro_fast.pdf` y el libro en `../PDF`.
- Cada perfil tiene sus propios `.aux`: alternar entre perfiles no hace pasadas de más ni deja un `.aux` truncado (el problema que `\CapitulosPorInput` resolvía).
- **No correr el menú viejo y la app a la vez sobre el mismo proyecto**: escriben los mismos auxiliares de la raíz. La app avisa si hay un `pdflatex` suelto.
