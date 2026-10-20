# Smoke de aceptación de F8b (la pantalla Proyecto y la barra mientras compila): abre en la app una copia TIBIA del libro SIN
# latexviewer.json y SIN parchear (cache de figuras del sello actual, sin ningún .aux), y corre dentro de la app real (LV_SMOKE=f8b):
# la pantalla se abre sola, detecta, prueba, se confirma, y con lo guardado compila el parcial con Butterworth mientras la barra
# muestra la etiqueta, la pasada y la herramienta. Después el script compara el latexviewer.json escrito con
# fixtures\configs\libro-tc.latexviewer.json (scripts\comparar-config.py): tiene que ser el mismo sin haber escrito nada a mano.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f8b.ps1 [-LimiteMin 20] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle), el cache tibio de fixtures\libro-tc y Python en el PATH. Trabaja sobre una
# copia en spikes\work\f8b-smoke\ (ignorada por git); inspo\ no se toca. Sale con 0 si todo dio ok.

param(
    [int]$LimiteMin = 20,
    [int]$PausaMs = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$exe = if ($env:LV_APP_EXE) { $env:LV_APP_EXE } else { Join-Path $repo 'target\release\lv-app.exe' }
$abiertas = @(Get-Process -Name 'lv-app' -ErrorAction SilentlyContinue)
if ($abiertas.Count -gt 0 -and $env:LV_ACEPTAR_APP_ABIERTA -ne '1') {
    Write-Host ("Hay {0} instancia(s) de lv-app.exe abierta(s) (PID {1}). Cerrala(s) y volvé a correr el smoke." -f $abiertas.Count, (($abiertas | ForEach-Object { $_.Id }) -join ', ')) -ForegroundColor Red
    exit 2
}
if (-not (Test-Path $exe)) { throw "Falta $exe. Compilá con: npx tauri build --no-bundle" }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Falta Python en el PATH (comparar-config.py).' }

$base = Join-Path $repo 'spikes\work\f8b-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'

# --- la copia tibia, sin config y sin parchear -----------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f8b-smoke\Proyecto' | Out-Null
$sello = (Get-FileHash (Join-Path $carpeta 'estilo_figuras.tex') -Algorithm MD5).Hash.Substring(0, 6)
$cache = Join-Path $carpeta 'figuras-cache'
$figuras = @(Get-ChildItem $cache -File | Where-Object { $_.Name -like "$sello-*" }).Count
if ($figuras -eq 0) { throw "El cache de fixtures\libro-tc no tiene figuras del sello ${sello}: corré antes la línea de base (scripts\bench-base.ps1)." }
Get-ChildItem $cache -File | Where-Object { $_.Name -notlike "$sello-*" } | Remove-Item -Force
$basura = '.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind', '.lof', '.lot', '.out', '.log', '.gz', '.auxlock'
Get-ChildItem $carpeta -Recurse -File -Force |
    Where-Object { $_.FullName -notlike "$cache\*" -and $_.FullName -notlike "$carpeta\.lv\*" -and ($basura -contains $_.Extension.ToLower() -or $_.Name -like '*.run.xml') } |
    Remove-Item -Force
foreach ($sobra in '.lv', 'latexviewer.json') {
    $r = Join-Path $carpeta $sobra
    if (Test-Path $r) { Remove-Item $r -Recurse -Force }
}
$pdfs = Join-Path $base 'PDF'
if (Test-Path $pdfs) { Remove-Item $pdfs -Recurse -Force }
Write-Host "Copia tibia lista: $figuras figuras del sello $sello, sin latexviewer.json, sin parchear."

$tex0 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count

$env:LV_SMOKE = 'f8b'
$env:LV_OPEN = $carpeta
Remove-Item Env:LV_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:LV_SMOKE_FILE -ErrorAction SilentlyContinue
$env:LV_SMOKE_OUT = $salida
$env:LV_CONFIG_DIR = Join-Path $base 'config'
New-Item -ItemType Directory -Force $env:LV_CONFIG_DIR | Out-Null
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }
Remove-Item $salida -ErrorAction SilentlyContinue

Write-Host 'Smoke de F8b sobre el libro...'
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
while (-not $p.HasExited -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 300 }
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
    Write-Host ('{0} {1,-115} {2,7:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
    if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
}
Write-Host ''

# --- lo que sólo se ve desde afuera ---------------------------------------------------------------------------------------
$extra = $true
$escrito = Join-Path $carpeta 'latexviewer.json'
$esperado = Join-Path $repo 'fixtures\configs\libro-tc.latexviewer.json'
if (-not (Test-Path $escrito)) {
    Write-Host 'La app no escribió latexviewer.json.' -ForegroundColor Red
    $extra = $false
} else {
    $dif = & python -I (Join-Path $PSScriptRoot 'comparar-config.py') $escrito $esperado 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'latexviewer.json escrito por la app = fixtures\configs\libro-tc.latexviewer.json (sin escribir nada a mano).' -ForegroundColor Green
    } else {
        Write-Host 'latexviewer.json NO es el del fixture:' -ForegroundColor Red
        $dif | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        $extra = $false
    }
}
$estado = Join-Path $carpeta '.lv\state.json'
if (Test-Path $estado) {
    $e = Get-Content $estado -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ("state.json: raíz = {0}" -f $(if ($e.PSObject.Properties.Name -contains 'root') { $e.root } else { '(no la guarda)' }))
}

Start-Sleep -Seconds 2
$tex1 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count
$huerfanos = [math]::Max(0, $tex1 - $tex0)
Write-Host ("total {0} s; procesos de TeX que quedaron vivos: {1}" -f $seg, $huerfanos)
Write-Host ("medidas: " + (($r | Select-Object arranqueMs, detectarMs, probarMs, parcialMs, pasosVistos, figuraVistaEnLaBarra | ConvertTo-Json -Compress -Depth 4)))
if ($r.historial) { Write-Host 'historial (lo más nuevo primero):'; $r.historial | ForEach-Object { Write-Host "  $_" } }
if ($huerfanos -gt 0) { Write-Host 'Quedaron procesos de TeX vivos.' -ForegroundColor Red }
if ($r.ok -and $extra -and $huerfanos -eq 0) { Write-Host 'SMOKE OK' -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
