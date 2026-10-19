# Smoke de aceptación de F4: SyncTeX sobre el libro, dentro de la app real (LV_SMOKE=f4). Compila el rápido en una copia
# TIBIA del libro y mide, en 50 párrafos largos al azar (semilla fija), cuántas veces el forward cae en la palabra correcta,
# cuántas el inverse deja el cursor a una palabra o menos, y cuánto tarda cada salto (criterio de F4 del plan: >= 90 %,
# >= 90 % y <= 150 ms).
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f4.ps1 [-LimiteMin 25]
#
# Necesita la app compilada (npx tauri build --no-bundle) y el cache de figuras tibio de fixtures\libro-tc. Trabaja sobre una
# copia en spikes\work\f4-smoke\ (ignorada por git); inspo\ no se toca. Sale con 0 si el smoke dio ok.

param([int]$LimiteMin = 25)

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

$base = Join-Path $repo 'spikes\work\f4-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'

# La copia tibia, como la de F2: sin .aux ni PDF, con el cache de figuras del sello actual y con latexviewer.json.
& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f4-smoke\Proyecto' | Out-Null
$sello = (Get-FileHash (Join-Path $carpeta 'estilo_figuras.tex') -Algorithm MD5).Hash.Substring(0, 6)
$cache = Join-Path $carpeta 'figuras-cache'
if (@(Get-ChildItem $cache -File | Where-Object { $_.Name -like "$sello-*" }).Count -eq 0) { throw "El cache de fixtures\libro-tc no tiene figuras del sello ${sello}: corré antes la línea de base." }
Get-ChildItem $cache -File | Where-Object { $_.Name -notlike "$sello-*" } | Remove-Item -Force
$basura = '.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind', '.lof', '.lot', '.out', '.log', '.gz', '.auxlock'
Get-ChildItem $carpeta -Recurse -File -Force |
    Where-Object { $_.FullName -notlike "$cache\*" -and $_.FullName -notlike "$carpeta\.lv\*" -and ($basura -contains $_.Extension.ToLower() -or $_.Name -like '*.run.xml') } |
    Remove-Item -Force
if (Test-Path (Join-Path $carpeta '.lv')) { Remove-Item (Join-Path $carpeta '.lv') -Recurse -Force }
$pdfs = Join-Path $base 'PDF'
if (Test-Path $pdfs) { Remove-Item $pdfs -Recurse -Force }
Copy-Item (Join-Path $repo 'fixtures\configs\libro-tc.latexviewer.json') (Join-Path $carpeta 'latexviewer.json') -Force

$env:LV_SMOKE = 'f4'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'Funciones de Aproximación.tex'
$env:LV_SMOKE_OUT = $salida
Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue

Write-Host "Smoke de F4 sobre el libro (compila el rápido y mide 50 saltos)..."
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
while (-not $p.HasExited -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
if (-not $p.HasExited) {
    cmd /c "taskkill /PID $($p.Id) /T /F > NUL 2>&1"
    Write-Host "TOPE de $LimiteMin minutos: se cortó la app." -ForegroundColor Red
}
$seg = [int]((Get-Date) - $t).TotalSeconds

if (-not (Test-Path $salida)) { Write-Host "La app no dejó resultado ($salida)." -ForegroundColor Red; exit 1 }
$r = Get-Content $salida -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ""
foreach ($s in $r.pasos) {
    $marca = if ($s.ok) { 'ok   ' } else { 'FALLA' }
    $color = if ($s.ok) { 'Green' } else { 'Red' }
    Write-Host ('{0} {1,-100} {2,6:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
    if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
}
Write-Host ""
Write-Host ("total {0} s" -f $seg)
Write-Host ("medidas: " + (($r | Select-Object paginas, candidatos, forward, inverse, tiempoMs, alineacion, dobleClic | ConvertTo-Json -Compress -Depth 4)))
if ($r.fallas) { Write-Host "primeras fallas:"; $r.fallas | Select-Object -First 8 | ForEach-Object { Write-Host ("  {0}:{1} «{2}» fwd={3} inv={4} {5}" -f $_.rel, $_.n, $_.palabra, $_.fwdOk, $_.invOk, $_.nota) } }
if ($r.ok) { Write-Host "SMOKE OK" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
