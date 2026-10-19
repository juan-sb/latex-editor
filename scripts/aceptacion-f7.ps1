# Smoke de aceptación de F7: abre en la app una copia TIBIA del libro (cache de figuras del sello actual, sin ningún .aux, con el
# latexviewer.json del repo y la guardia a \OpcionPie) y corre dentro de la app real (LV_SMOKE=f7): la variable OpcionPie en el
# documento, Ctrl+Alt+T y Ctrl+\ con teclado real, la vista previa de un fragmento, exportar dos partes con el número impreso y
# archivos cambiados afuera.
#
# Este último paso lo hace este script junto con la app: la app avisa que está lista (`.lv\f7-listo.txt`), el script reescribe las
# figuras de los engranajes corriendo Herramientas\gen_engranajes.py con otro ángulo de presión, y la app tiene que compilar UNA
# vez, recocinar sólo las 2 figuras del anexo y quedar quieta. Después se comparan los PDF del rápido, antes y después, página a
# página (scripts\comparar-pdf.py): tiene que cambiar una sola, la de los engranajes.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f7.ps1 [-LimiteMin 20] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle), el cache tibio de fixtures\libro-tc (lo deja bench-base.ps1 o cualquier
# build de la línea de base) y Python en el PATH (el libro lo usa para generar sus figuras). Trabaja sobre una copia en
# spikes\work\f7-smoke\ (ignorada por git); inspo\ no se toca. Sale con 0 si todo dio ok.

param(
    [int]$LimiteMin = 20,
    # Milisegundos que la app deja la interfaz abierta al terminar: alcanza para sacarle una captura.
    [int]$PausaMs = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
# LV_APP_EXE: otro ejecutable de la app (por ejemplo cuando hay una instancia abierta y no se puede reemplazar target\release\lv-app.exe).
$exe = if ($env:LV_APP_EXE) { $env:LV_APP_EXE } else { Join-Path $repo 'target\release\lv-app.exe' }
# Una instancia abierta de la app (la de la persona) impide recompilar target\release\lv-app.exe y falsea la memoria que mide el smoke de
# F2: se avisa y se frena. LV_ACEPTAR_APP_ABIERTA=1 lo deja pasar (con otro ejecutable en LV_APP_EXE, por ejemplo).
$abiertas = @(Get-Process -Name 'lv-app' -ErrorAction SilentlyContinue)
if ($abiertas.Count -gt 0 -and $env:LV_ACEPTAR_APP_ABIERTA -ne '1') {
    Write-Host ("Hay {0} instancia(s) de lv-app.exe abierta(s) (PID {1}). Cerrala(s) y volvé a correr el smoke." -f $abiertas.Count, (($abiertas | ForEach-Object { $_.Id }) -join ', ')) -ForegroundColor Red
    exit 2
}
if (-not (Test-Path $exe)) { throw "Falta $exe. Compilá con: npx tauri build --no-bundle" }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Falta Python en el PATH (gen_engranajes.py).' }

$base = Join-Path $repo 'spikes\work\f7-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'
$utf8 = New-Object Text.UTF8Encoding $false

# --- la copia tibia (la misma que la de F2) -----------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f7-smoke\Proyecto' | Out-Null
$sello = (Get-FileHash (Join-Path $carpeta 'estilo_figuras.tex') -Algorithm MD5).Hash.Substring(0, 6)
$cache = Join-Path $carpeta 'figuras-cache'
$figuras = @(Get-ChildItem $cache -File | Where-Object { $_.Name -like "$sello-*" }).Count
if ($figuras -eq 0) { throw "El cache de fixtures\libro-tc no tiene figuras del sello ${sello}: corré antes la línea de base (scripts\bench-base.ps1)." }
Get-ChildItem $cache -File | Where-Object { $_.Name -notlike "$sello-*" } | Remove-Item -Force
$basura = '.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind', '.lof', '.lot', '.out', '.log', '.gz', '.auxlock'
Get-ChildItem $carpeta -Recurse -File -Force |
    Where-Object { $_.FullName -notlike "$cache\*" -and $_.FullName -notlike "$carpeta\.lv\*" -and ($basura -contains $_.Extension.ToLower() -or $_.Name -like '*.run.xml') } |
    Remove-Item -Force
if (Test-Path (Join-Path $carpeta '.lv')) { Remove-Item (Join-Path $carpeta '.lv') -Recurse -Force }
$pdfs = Join-Path $base 'PDF'
if (Test-Path $pdfs) { Remove-Item $pdfs -Recurse -Force }
# La guardia de \OpcionPie y el latexviewer.json del repo (con `export.dir` adentro de la copia, para poder leer los PDF).
& (Join-Path $PSScriptRoot 'parchear-libro-f7.ps1') -Carpeta $carpeta -ExportDir 'export' | Out-Null
$genRuta = Join-Path $carpeta 'Herramientas\gen_engranajes.py'
$genOriginal = [IO.File]::ReadAllText($genRuta, $utf8)
Write-Host "Copia tibia lista: $figuras figuras del sello $sello, sin auxiliares, con la guardia a \OpcionPie."

$tex0 = @(Get-Process pdflatex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count

$env:LV_SMOKE = 'f7'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'Funciones de Aproximación.tex'
$env:LV_SMOKE_FILE = 'Secciones/Desnormalización.tex'
$env:LV_SMOKE_OUT = $salida
$env:LV_CONFIG_DIR = Join-Path $base 'config'
New-Item -ItemType Directory -Force $env:LV_CONFIG_DIR | Out-Null
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host 'Smoke de F7 sobre el libro...'
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
$listo = Join-Path $carpeta '.lv\f7-listo.txt'
$hizoElCambio = $false
$pdfRapido = Join-Path $carpeta '.lv\build\rapido\lv-rapido.pdf'
$antesPdf = Join-Path $base 'rapido-antes.pdf'
while (-not $p.HasExited -and (Get-Date) -lt $limite) {
    if (-not $hizoElCambio -and (Test-Path $listo)) {
        # La app está lista y quieta: el estado de partida del rápido es éste.
        Copy-Item $pdfRapido $antesPdf -Force
        # Otro ángulo de presión: cambian las dos figuras de los engranajes (`fig_engranaje_*.tex`), que entran por \input dentro de un
        # tikzpicture del anexo de Cauer. pgf no ve el cambio (hashea la línea `\input`): lo ve la app.
        [IO.File]::WriteAllText($genRuta, $genOriginal.Replace('ALPHA = 25.0 ', 'ALPHA = 20.0 '), $utf8)
        Push-Location $carpeta
        try { & python 'Herramientas\gen_engranajes.py' | Out-Null } finally { Pop-Location }
        [IO.File]::WriteAllText((Join-Path $carpeta '.lv\f7-gen.txt'), "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())`n", $utf8)
        $hizoElCambio = $true
        Write-Host '  gen_engranajes.py corrido: la app tiene que compilar sola.'
    }
    Start-Sleep -Milliseconds 300
}
if (-not $p.HasExited) {
    cmd /c "taskkill /PID $($p.Id) /T /F > NUL 2>&1"
    Write-Host "TOPE de $LimiteMin minutos: se cortó la app." -ForegroundColor Red
}
$seg = [int]((Get-Date) - $t).TotalSeconds

if (-not (Test-Path $salida)) { Write-Host "La app no dejó resultado ($salida)." -ForegroundColor Red; exit 1 }
$r = Get-Content $salida -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
foreach ($s in $r.pasos) {
    $marca = if ($s.ok) { 'ok   ' } else { 'FALLA' }
    $color = if ($s.ok) { 'Green' } else { 'Red' }
    Write-Host ('{0} {1,-100} {2,7:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
    if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
}
Write-Host ''

# --- lo que sólo se ve desde afuera ---------------------------------------------------------------------------------------
$extra = $true
# Los PDF exportados están, con el número impreso en el nombre.
foreach ($n in '08 - Funciones de Aproximación.pdf', '09 - Aproximación de Butterworth.pdf') {
    $ruta = Join-Path $carpeta "export\$n"
    if (-not (Test-Path $ruta)) { Write-Host "Falta el PDF exportado «$n»." -ForegroundColor Red; $extra = $false }
}
$exportados = @(Get-ChildItem (Join-Path $carpeta 'export') -Filter *.pdf -ErrorAction SilentlyContinue).Count
Write-Host ("PDF exportados en la carpeta: {0}" -f $exportados)
# El PDF del rápido cambió en una sola página: la de los engranajes.
if ($hizoElCambio -and (Test-Path $antesPdf)) {
    $diff = & python (Join-Path $PSScriptRoot 'comparar-pdf.py') $antesPdf $pdfRapido 60 (Join-Path $base 'raster') 2>&1 | ForEach-Object { "$_" }
    $diff | ForEach-Object { Write-Host "  $_" }
    $distintas = ($diff | Where-Object { $_ -match 'páginas distintas: (\d+)' } | ForEach-Object { [int]$Matches[1] } | Select-Object -First 1)
    if ($distintas -ne 1) { Write-Host "El PDF del rápido debía cambiar en 1 página y cambió en $distintas." -ForegroundColor Red; $extra = $false }
} else {
    Write-Host 'El script no llegó a reescribir los engranajes (la app no avisó que estaba lista).' -ForegroundColor Red
    $extra = $false
}

Start-Sleep -Seconds 2
$tex1 = @(Get-Process pdflatex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count
$huerfanos = [math]::Max(0, $tex1 - $tex0)
Write-Host ("total {0} s; procesos de TeX que quedaron vivos: {1}" -f $seg, $huerfanos)
Write-Host ("medidas: " + (($r | Select-Object arranqueMs, pie_ninguno_ms, pie_completo_ms, fragmentoFrioMs, fragmentoTibioMs, exportarDosMs, observadorHastaBuildMs, observadorHastaPdfMs, figurasRecocinadas | ConvertTo-Json -Compress -Depth 4)))
if ($huerfanos -gt 0) { Write-Host 'Quedaron procesos de TeX vivos.' -ForegroundColor Red }
if ($r.ok -and $extra -and $huerfanos -eq 0) { Write-Host 'SMOKE OK' -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
