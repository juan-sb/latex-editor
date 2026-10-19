# Smoke de aceptación de F3: abre en la app una copia de fixtures\errores (un proyecto con problemas a propósito) y corre
# dentro de la app real (LV_SMOKE=f3): build que falla con el conteo del log, panel de problemas, marcas en el gutter,
# F8 con eventos de teclado reales, clic en el panel, filtros y marcas que siguen a las ediciones.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f3.ps1 [-LimiteMin 6] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle). Trabaja sobre una copia en spikes\work\f3-smoke\ (ignorada por
# git). Sale con 0 si el smoke dio ok.

param(
    [int]$LimiteMin = 6,
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

$base = Join-Path $repo 'spikes\work\f3-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Force $base | Out-Null
Copy-Item (Join-Path $repo 'fixtures\errores') $carpeta -Recurse

$env:LV_SMOKE = 'f3'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'main.tex'
$env:LV_SMOKE_OUT = $salida
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host "Smoke de F3 sobre fixtures\errores..."
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
while (-not $p.HasExited -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 400 }
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
if ($r.ok) { Write-Host "SMOKE OK" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
