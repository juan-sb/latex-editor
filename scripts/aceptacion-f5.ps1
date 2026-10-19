# Smoke de aceptación de F5: abre en la app una copia de fixtures\editor (un proyecto chico con lint a propósito) y corre
# dentro de la app real (LV_SMOKE=f5): formato con teclas reales, autocompletado con el menú de CodeMirror, F12 y Alt+Flecha,
# Ctrl+P, paleta, esquema, búsqueda y reemplazo contra el core y contra los bytes de disco, lint en el gutter y keybindings.json.
# No compila nada: no necesita TeX.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f5.ps1 [-LimiteMin 5] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle). Trabaja sobre una copia en spikes\work\f5-smoke\ (ignorada por
# git) y usa una carpeta de configuración propia (LV_CONFIG_DIR): no toca el keybindings.json real. Sale con 0 si dio ok.

param(
    [int]$LimiteMin = 5,
    # Milisegundos que la app deja la interfaz abierta al terminar: alcanza para sacarle una captura.
    [int]$PausaMs = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $repo 'target\release\lv-app.exe'
if (-not (Test-Path $exe)) { throw "Falta $exe. Compilá con: npx tauri build --no-bundle" }

$base = Join-Path $repo 'spikes\work\f5-smoke'
$carpeta = Join-Path $base 'Proyecto'
$config = Join-Path $base 'config'
$salida = Join-Path $base 'resultado.json'
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Force $base | Out-Null
New-Item -ItemType Directory -Force $config | Out-Null
Copy-Item (Join-Path $repo 'fixtures\editor') $carpeta -Recurse

$env:LV_SMOKE = 'f5'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'main.tex'
$env:LV_SMOKE_OUT = $salida
$env:LV_CONFIG_DIR = $config
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host "Smoke de F5 sobre fixtures\editor..."
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
