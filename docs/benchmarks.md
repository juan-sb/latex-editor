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
