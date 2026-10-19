# Smoke de aceptación de F8: historial, doctor y procesos (candado y huérfanos). Abre en la app una copia TIBIA del libro SIN la guardia
# a \OpcionPie (el doctor tiene que verla) y corre dentro de la app real (LV_SMOKE=f8):
#   - un pdflatex que quedó andando en la carpeta (lo lanza este script antes de abrir la app) se ofrece al abrir y se mata,
#   - el doctor corre al abrir y encuentra el \def incondicional de \OpcionPie, sin errores,
#   - un build, una cocción, una exportación, un fragmento, un build por guardado y otro por un archivo cambiado afuera dejan UNA línea
#     por trabajo en .lv\history.jsonl, con su motivo y sus pistas,
#   - una SEGUNDA instancia de la app sobre el mismo proyecto (la lanza este script cuando la primera avisa que está lista) ve el
#     candado, avisa y no compila, ni cocina, ni exporta.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f8.ps1 [-LimiteMin 20] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle) y el cache tibio de fixtures\libro-tc (lo deja bench-base.ps1 o cualquier
# build de la línea de base). Trabaja sobre una copia en spikes\work\f8-smoke\ (ignorada por git); inspo\ no se toca. Sale con 0 si todo dio ok.

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

$base = Join-Path $repo 'spikes\work\f8-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'
$salidaSegunda = Join-Path $base 'resultado-segunda.json'
$utf8 = New-Object Text.UTF8Encoding $false

# --- la copia tibia, sin la guardia ---------------------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f8-smoke\Proyecto' | Out-Null
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
& (Join-Path $PSScriptRoot 'parchear-libro-f7.ps1') -Carpeta $carpeta -ExportDir 'export' -SinGuardia | Out-Null
$structure = [IO.File]::ReadAllText((Join-Path $carpeta 'structure.tex'), $utf8)
if (-not $structure.Contains('\def\OpcionPie{completo}') -or $structure.Contains('\ifdefined\OpcionPie')) { throw 'La copia debía quedar sin la guardia a \OpcionPie.' }
Write-Host "Copia tibia lista: $figuras figuras del sello $sello, sin auxiliares, SIN guardia a \OpcionPie."

$tex0 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count

# --- el huérfano: un pdflatex en un bucle infinito de TeX, con la carpeta del proyecto como directorio actual ---------------
New-Item -ItemType Directory -Force (Join-Path $carpeta '.lv') | Out-Null
$huerfano = Start-Process -FilePath 'pdflatex' -ArgumentList '-interaction=nonstopmode', '"\def\a{\a}\a"' -WorkingDirectory $carpeta -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if ($huerfano.HasExited) { throw 'El pdflatex huérfano terminó solo: no hay forma de probar la detección.' }
[IO.File]::WriteAllText((Join-Path $carpeta '.lv\f8-pid.txt'), "$($huerfano.Id)`n", $utf8)
Write-Host "pdflatex huérfano andando (PID $($huerfano.Id))."

$env:LV_SMOKE = 'f8'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'Funciones de Aproximación.tex'
$env:LV_SMOKE_OUT = $salida
Remove-Item Env:LV_SMOKE_FILE -ErrorAction SilentlyContinue
$env:LV_CONFIG_DIR = Join-Path $base 'config'
New-Item -ItemType Directory -Force $env:LV_CONFIG_DIR | Out-Null
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }
Remove-Item $salida, $salidaSegunda -ErrorAction SilentlyContinue

Write-Host 'Smoke de F8 sobre el libro...'
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
$listo = Join-Path $carpeta '.lv\f8-listo.txt'
$lanzoSegunda = $false
$segundaSalio = $false
while (-not $p.HasExited -and (Get-Date) -lt $limite) {
    if (-not $lanzoSegunda -and (Test-Path $listo)) {
        $lanzoSegunda = $true
        Write-Host '  la primera instancia está lista: abro una segunda sobre el mismo proyecto.'
        $env:LV_SMOKE_FILE = 'segunda'
        $env:LV_SMOKE_OUT = $salidaSegunda
        $p2 = Start-Process -FilePath $exe -PassThru
        $limite2 = (Get-Date).AddMinutes(3)
        while (-not $p2.HasExited -and (Get-Date) -lt $limite2) { Start-Sleep -Milliseconds 300 }
        if (-not $p2.HasExited) {
            cmd /c "taskkill /PID $($p2.Id) /T /F > NUL 2>&1"
            Write-Host 'TOPE de 3 minutos: se cortó la segunda instancia.' -ForegroundColor Red
        } else { $segundaSalio = $true }
        Remove-Item Env:LV_SMOKE_FILE -ErrorAction SilentlyContinue
        $env:LV_SMOKE_OUT = $salida
        [IO.File]::WriteAllText((Join-Path $carpeta '.lv\f8-segunda.txt'), "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())`n", $utf8)
    }
    Start-Sleep -Milliseconds 300
}
if (-not $p.HasExited) {
    cmd /c "taskkill /PID $($p.Id) /T /F > NUL 2>&1"
    Write-Host "TOPE de $LimiteMin minutos: se cortó la app." -ForegroundColor Red
}
$seg = [int]((Get-Date) - $t).TotalSeconds

function Mostrar($titulo, $ruta) {
    if (-not (Test-Path $ruta)) { Write-Host "$titulo no dejó resultado ($ruta)." -ForegroundColor Red; return $null }
    $r = Get-Content $ruta -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ''
    Write-Host $titulo -ForegroundColor Cyan
    foreach ($s in $r.pasos) {
        $marca = if ($s.ok) { 'ok   ' } else { 'FALLA' }
        $color = if ($s.ok) { 'Green' } else { 'Red' }
        Write-Host ('{0} {1,-110} {2,7:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
        if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
    }
    return $r
}
$r = Mostrar 'Primera instancia' $salida
$r2 = Mostrar 'Segunda instancia' $salidaSegunda
Write-Host ''

# --- lo que sólo se ve desde afuera ---------------------------------------------------------------------------------------
$extra = $true
if (Get-Process -Id $huerfano.Id -ErrorAction SilentlyContinue) {
    Write-Host "El pdflatex huérfano (PID $($huerfano.Id)) sigue vivo." -ForegroundColor Red
    cmd /c "taskkill /PID $($huerfano.Id) /T /F > NUL 2>&1"
    $extra = $false
}
if (-not $segundaSalio) { Write-Host 'La segunda instancia no llegó a terminar sola.' -ForegroundColor Red; $extra = $false }
$hist = Join-Path $carpeta '.lv\history.jsonl'
if (Test-Path $hist) {
    $lineas = @(Get-Content $hist -Encoding UTF8 | Where-Object { $_.Trim() })
    $tipos = $lineas | ForEach-Object { ($_ | ConvertFrom-Json).tipo } | Group-Object | ForEach-Object { "$($_.Name)=$($_.Count)" }
    Write-Host ("history.jsonl: {0} líneas ({1}), {2} bytes" -f $lineas.Count, ($tipos -join ', '), (Get-Item $hist).Length)
} else {
    Write-Host 'No quedó .lv\history.jsonl.' -ForegroundColor Red
    $extra = $false
}
$lock = Join-Path $carpeta '.lv\lock'
if (Test-Path $lock) {
    # La app sale con `exit`: el candado queda en disco, pero con un PID que ya no existe. La próxima apertura lo reemplaza (lo prueban los tests).
    $pidLock = [int](Get-Content $lock -Raw | ConvertFrom-Json).pid
    $vivo = [bool](Get-Process -Id $pidLock -ErrorAction SilentlyContinue)
    Write-Host ("candado que quedó: PID {0}, vivo: {1}" -f $pidLock, $vivo)
    if ($vivo) { Write-Host 'El dueño del candado sigue vivo después de cerrar la app.' -ForegroundColor Red; $extra = $false }
} else {
    Write-Host 'candado: se soltó al cerrar.'
}

Start-Sleep -Seconds 2
$tex1 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count
$quedaron = [math]::Max(0, $tex1 - $tex0)
Write-Host ("total {0} s; procesos de TeX que quedaron vivos: {1}" -f $seg, $quedaron)
if ($r) { Write-Host ("medidas: " + (($r | Select-Object arranqueMs, doctorMs, doctorDistribucion, matarHuerfanosMs, huerfanosMs, historialEsperado, historialObtenido | ConvertTo-Json -Compress -Depth 4))) }
if ($r -and $r.doctor) { Write-Host 'doctor:'; $r.doctor | ForEach-Object { Write-Host "  $_" } }
if ($r -and $r.historialPistas) { Write-Host 'historial (lo más nuevo primero):'; $r.historialPistas | ForEach-Object { Write-Host "  $_" } }
if ($quedaron -gt 0) { Write-Host 'Quedaron procesos de TeX vivos.' -ForegroundColor Red }
if ($r -and $r2 -and $r.ok -and $r2.ok -and $extra -and $quedaron -eq 0) { Write-Host 'SMOKE OK' -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo) $($r2.fallo)" -ForegroundColor Red
exit 1
