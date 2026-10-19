# Revisión previa a F6

Revisión de F0 a F5 (commits `98789b3` a `9c6ed40`) antes de arrancar el cache de figuras. Se leyeron `plan.md`, `CLAUDE.md`, `docs/benchmarks.md`, `docs/spikes/S1.md` a `S4.md` y el código de `lv-core` que toca a F6 (`build.rs`, `session.rs`, `auxiliares.rs`, `config.rs`).

## Veredicto

F0 a F5 están bien hechos: cada fase cerró con sus criterios medidos, los desvíos están escritos en el plan y no apareció nada que haya que rehacer. Antes de F6 hay que cambiar el **plan de F6** (sección 7 y la fase), porque la revisión encontró un problema de pgf que la app ya arrastra y tres cosas que F6 tiene que hacer distinto de lo que decía el plan. El código de F1 a F5 no se toca antes; lo que corrige va dentro de F6.

## Lo que se verificó por fuera

- `npx vitest run` y `npx tsc --noEmit` en una copia limpia (`npm ci`, Linux, Node 22.23): **177 tests verdes y typecheck sin errores**, los mismos números que dice `benchmarks.md`. Además confirma que el frontend anda con Node 22.
- Los tests de Rust no se corrieron (no hay `cargo` en esa máquina; los de sesión y build son `#![cfg(windows)]` de todos modos).
- Experimentos con **TeX Live 2022 + latexmk 4.76** sobre una copia de `fixtures/tikz-figuras` (sin `babel` spanish, que esa instalación no trae), con el esquema A tal como lo genera `render_latexmkrc` y dos perfiles. Los resultados van abajo.

## Hallazgos

### 1. pgf da por buena una figura cuya subcompilación falló o se cortó (afecta a la app hoy)

pgf escribe el `.md5` nuevo de una figura **antes** de lanzar su subcompilación: está en `tikzexternalshared.code.tex`, dentro de `\tikzexternal@check@uptodate@mode`, que corre antes del `system call`. Si la subcompilación falla, o el build se cancela mientras corre, queda el `.md5` nuevo al lado del PDF viejo (o de uno cortado), y desde ahí pgf considera la figura al día.

Reproducido con TeX Live: se agregó `\comandoQueNoExiste` dentro del primer `tikzpicture` de `fixtures/tikz-figuras`.

| Paso | Resultado |
|---|---|
| Build con la figura rota | latexmk sale con **0**, ningún error en el log principal; la subcompilación sí falló (`fx-0.log`: `Undefined control sequence`, `no output PDF file produced`) |
| PDF de la figura | el de antes, byte a byte (mismo md5) |
| Build siguiente, sin tocar nada | 0 subcompilaciones, 0 errores: la figura vieja queda como buena |

pgf no da error porque encuentra **un** PDF con ese nombre, aunque sea el viejo. Con un PDF cortado por una cancelación pasa lo mismo, y ahí el que falla es el build que lo incluye.

En la app se agrava: `Session::al_terminar` llama a `aux::move_md5` después de **cualquier** build, cancelado o fallido, así que el `.md5` que miente pasa al cache compartido y lo heredan todos los perfiles. El panel de problemas de F3 no lo puede mostrar: el error está en el `.log` de la figura, no en el del perfil.

Le pasaba igual a inspo (cada Ctrl+S que mataba una cocción podía dejar una figura en este estado), sólo que nadie lo veía.

### 2. TeX Live: anda el esquema A, pero no crea la carpeta del cache dentro del directorio de salida

Con `-output-directory`, TeX Live no crea `.lv/build/<perfil>/figuras-cache/`: el primer build falla con `I can't write on file 'figuras-cache/lv-p1-figure0.md5'` y `Emergency stop`. MiKTeX la crea solo (por eso S1 no lo vio, igual que con las subcarpetas de `\include`). Creando esa carpeta y `figuras-cache/` en la raíz:

| Paso | Subcompilaciones |
|---|---|
| p1 en frío | 2 |
| p2 en frío (mismo cache) | 0 |
| p1 sin cambios | 0 (0 pasadas) |
| cambio en una figura, p1 | 1 |
| p2 después | 0 |

`TEXINPUTS` y mover los `.md5` funcionan igual que en MiKTeX. Esto cierra buena parte del riesgo "TeX Live sin probar" de S1; el libro entero no se probó ahí porque esa instalación no trae biblatex.

### 3. TeX Live no conoce `-max-print-line`

`pdflatex -max-print-line=10000` en TeX Live avisa `unrecognized option '-max-print-line=10000'` y sigue con el log cortado a 79 columnas (sale con 0). No rompe nada, pero el parser de F3 recibe rutas partidas. Arreglo: poner también `max_print_line=10000` en el entorno de latexmk (MiKTeX lo ignora).

### 4. `mode=graphics if exists` permite que el completo use el cache sin subcompilar

El completo tarda 338 s en esta máquina: 4 pasadas de ~82 s, sin cache de figuras. Es lo más lento que queda, bastante más que lo que ataca el formato precompilado de F10. inspo no lo externaliza porque la **subcompilación** de una figura tropieza con la portada y el `.toc` (fila 10 de la tabla del plan). Con `external/mode=graphics if exists`, pgf usa el PDF del cache si existe y, si no, dibuja la figura en línea: **nunca subcompila**.

Probado con TeX Live sobre el fixture, con el modo inyectado desde el driver (`\AddToHook{begindocument/before}{\tikzset{external/mode=graphics if exists}}`): 0 subcompilaciones; con una figura borrada del cache, se dibujó en línea sin lanzar nada. La contracara: en ese modo pgf no mira el `.md5`, así que usa una figura vieja si el código cambió (se vio también). Por eso el completo tiene que correr después de una cocción. Queda como spike S5 de F6, con el libro.

### 5. Detalles de F6 que el plan no tenía

- **El listado tiene que ser de todas las partes.** La figlist de un parcial sólo nombra las figuras de sus partes: la limpieza ("borrar lo que no esté en la figlist") contra esa lista borraría las figuras de todos los otros capítulos. inspo lista con `libro_cocina.tex`, que trae todo.
- **Pendiente por contenido del `.md5`, no por fecha.** Con el esquema A los `.md5` cambian de carpeta; en Windows `fs::copy` conserva la fecha, en Linux no. `move_md5` debería usar `fs::rename` (misma unidad, atómico) en lugar de copiar y borrar.
- **La cocción y los builds no pueden correr a la vez** (escribirían las mismas figuras). Hoy la cola es "un build y un pendiente" (`Builder::is_running` + `pendiente: Option<String>`); F6 agrega un trabajo que no es latexmk y lanza N procesos, y F7 agrega exportar todo y fragmentos. Conviene pasar a una cola de trabajos tipados con un solo ejecutor antes de escribir la cocción.
- **Prioridad después de un cambio de estilo.** El parcial necesita 46 de las 158 figuras: cocinar primero ésas y compilar deja el PDF a la vista en un tercio del tiempo; las otras siguen después, cediendo el paso a los builds.

### 6. Otros

- **Node 20 terminó su soporte el 30 de abril de 2026**, y `pdfjs-dist` 6.x pide ≥ 22.13 (hoy se tolera con `engine-strict=false` en `.npmrc`). En esta revisión el frontend pasó tests y typecheck con Node 22.23. Pasar la máquina de desarrollo a Node 22 LTS y sacar el override.
- **No hay watcher de archivos.** El plan lo tiene en 3.1 (`notify`), 3.4 (`fs:changed`) y 10.1 (recargar pestañas cambiadas afuera), pero en ninguna fase, y no se implementó. Hoy un archivo cambiado afuera no se recarga (el control de versión de `write_file` evita pisarlo, eso sí). Para el libro importa: los scripts de `Herramientas/` reescriben `Secciones/fig_*.tex`. Se asigna a F7.
- `src/store/app.ts` tiene 1140 líneas en un solo store; F6 a F8 le suman figuras, exportación, historial y doctor. Conviene partirlo en slices cuando se toque, no antes.
- Lo que F4 y F5 dejaron afuera a conciencia (CLI de SyncTeX como fallback, buscar en la parte cuando SyncTeX cae en el preámbulo, vista previa de `\includegraphics`, `Ctrl+\`) está bien postergado.
- Cada build paga ~0,6 s de latexmk aunque no haya nada que hacer (el "sin cambios"). Con el parcial a 4,93 s contra un umbral de 5,0 s, es una idea para F10: correr pdflatex directo cuando sólo cambió texto del cuerpo y dejar latexmk para lo demás.

## Cambios al plan

En `plan.md`: 5.1 (`max_print_line` en el entorno), 5.4 (TeX Live probado con el fixture), 7 (figuras que fallan o se cortan, listado con todas las partes, pendiente por contenido, prioridad, completo con cache), F6 (lista y aceptación), F7 (watcher) y 14 (riesgos).
