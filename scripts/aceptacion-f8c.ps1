# Smoke de aceptación de F8c (imágenes en borrador y botones de salto sobre la barra separadora): abre en la app una copia de
# fixtures\imagenes (dos \includegraphics de una imagen PNG que este script genera) y corre dentro de la app real (LV_SMOKE=f8c): la
# geometría de los botones en el DOM, el interruptor de borrador (driver, páginas, tamaño del PDF), que un PDF en borrador no se
# publica y la entrega nunca va en borrador, los dos saltos y que apretar un botón no arrastra la barra.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f8c.ps1 [-LimiteMin 10] [-PausaMs 0]
#
# Necesita la app compilada (npx tauri build --no-bundle) y TeX. Trabaja sobre una copia en spikes\work\f8c-smoke\ (ignorada por
# git). Sale con 0 si todo dio ok.

param(
    [int]$LimiteMin = 10,
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

$base = Join-Path $repo 'spikes\work\f8c-smoke'
$carpeta = Join-Path $base 'Proyecto'
$config = Join-Path $base 'config'
$salida = Join-Path $base 'resultado.json'
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Force $base | Out-Null
New-Item -ItemType Directory -Force $config | Out-Null
Copy-Item (Join-Path $repo 'fixtures\imagenes') $carpeta -Recurse

# La imagen: un degradé con ruido (un PNG que no comprime del todo, para que el PDF completo pese bastante más que el borrador).
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 600
$azar = New-Object System.Random 42
for ($y = 0; $y -lt 600; $y++) {
    for ($x = 0; $x -lt 900; $x++) {
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(($x * 255 / 900), ($y * 255 / 600), $azar.Next(0, 256)))
    }
}
$bmp.Save((Join-Path $carpeta 'foto.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("foto.png: {0:N0} KB" -f ((Get-Item (Join-Path $carpeta 'foto.png')).Length / 1KB))

$tex0 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count

$env:LV_SMOKE = 'f8c'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'main.tex'
Remove-Item Env:LV_SMOKE_FILE -ErrorAction SilentlyContinue
$env:LV_SMOKE_OUT = $salida
$env:LV_CONFIG_DIR = $config
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host 'Smoke de F8c sobre fixtures\imagenes...'
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
    Write-Host ('{0} {1,-125} {2,6:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
    if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
}
Write-Host ''

# --- lo que sólo se ve desde afuera ---------------------------------------------------------------------------------------
$extra = $true
foreach ($nombre in 'Imagenes.pdf', 'main.pdf') {
    $pub = Join-Path $base "PDF\$nombre"
    if (Test-Path $pub) { Write-Host ("publicado: $nombre ({0:N0} KB)" -f ((Get-Item $pub).Length / 1KB)) -ForegroundColor Green }
    else { Write-Host "No quedó publicado PDF\$nombre." -ForegroundColor Red; $extra = $false }
}
$entrega = Join-Path $base 'PDF\Imagenes.pdf'
$completo = Join-Path $base 'PDF\main.pdf'
if ((Test-Path $entrega) -and (Test-Path $completo)) {
    # Lo publicado con el interruptor prendido (la entrega) pesa lo mismo que lo publicado con las imágenes completas: ninguno es borrador.
    $a = (Get-Item $entrega).Length
    $b = (Get-Item $completo).Length
    if ([math]::Abs($a - $b) -gt ($b * 0.05)) { Write-Host "La entrega ($a bytes) y el completo ($b bytes) difieren demasiado." -ForegroundColor Red; $extra = $false }
}

Start-Sleep -Seconds 2
$tex1 = @(Get-Process pdflatex, miktex-pdftex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count
$huerfanos = [math]::Max(0, $tex1 - $tex0)
Write-Host ("total {0} s; procesos de TeX que quedaron vivos: {1}" -f $seg, $huerfanos)
Write-Host ("medidas: " + (($r | Select-Object arranqueMs, botones, completo, borrador, arrastre, tramoCodigo | ConvertTo-Json -Compress -Depth 4)))
if ($huerfanos -gt 0) { Write-Host 'Quedaron procesos de TeX vivos.' -ForegroundColor Red }
if ($r.ok -and $extra -and $huerfanos -eq 0) { Write-Host 'SMOKE OK' -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
