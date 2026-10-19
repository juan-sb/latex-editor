# Smoke de aceptación de F2: abre en la app una copia TIBIA del libro (cache de figuras del sello actual, sin ningún .aux,
# con latexviewer.json), y corre dentro de la app real (LV_SMOKE=f2): perfiles parcial y rápido, sembrado, sin cambios,
# alternar, Ctrl+S de guardar a PDF visible, cola, cancelación, recarga del PDF sin parpadeo y publicar.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f2.ps1 [-LimiteMin 25] [-PausaMs 0]
#
# Necesita la app compilada: npx tauri build --no-bundle (deja target\release\lv-app.exe) y el cache tibio de
# fixtures\libro-tc (lo deja scripts\bench-base.ps1 o cualquier build de la línea de base). Trabaja siempre sobre una copia
# en spikes\work\f2-smoke\ (ignorada por git); inspo\ no se toca. Sale con 0 si el smoke dio ok.

param(
    [int]$LimiteMin = 25,
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

$base = Join-Path $repo 'spikes\work\f2-smoke'
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'

# --- la copia tibia ---------------------------------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f2-smoke\Proyecto' | Out-Null
# El estado de partida: ni .aux ni .fdb_latexmk de otras corridas, ni PDF publicados, y del cache de figuras sólo el sello actual.
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
Copy-Item (Join-Path $repo 'fixtures\configs\libro-tc.latexviewer.json') (Join-Path $carpeta 'latexviewer.json') -Force
Write-Host "Copia tibia lista: $figuras figuras del sello $sello, sin auxiliares, con latexviewer.json."

$tex0 = @(Get-Process pdflatex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count

$env:LV_SMOKE = 'f2'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = 'Funciones de Aproximación.tex'
$env:LV_SMOKE_FILE = 'Secciones/Desnormalización.tex'
$env:LV_SMOKE_OUT = $salida
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host "Smoke de F2 sobre el libro..."
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
# Memoria del WebView (los procesos de WebView2 y la app, sin los de TeX) cada medio segundo: la ventana de las recargas
# del PDF se compara al final (criterio de 5.7: memoria estable a 40 recargas seguidas).
$serie = New-Object System.Collections.Generic.List[object]
$ids = @()
$ultimaBusqueda = [DateTime]::MinValue
while (-not $p.HasExited -and (Get-Date) -lt $limite) {
    if (((Get-Date) - $ultimaBusqueda).TotalSeconds -ge 5) {
        $todos = Get-CimInstance Win32_Process
        $arbol = @($p.Id)
        do {
            $nuevos = @($todos | Where-Object { ($arbol -contains $_.ParentProcessId) -and ($arbol -notcontains $_.ProcessId) } | ForEach-Object { $_.ProcessId })
            $arbol += $nuevos
        } while ($nuevos.Count -gt 0)
        $ids = @($todos | Where-Object { ($arbol -contains $_.ProcessId) -and ($_.Name -match 'webview2|lv-app') } | ForEach-Object { $_.ProcessId })
        $ultimaBusqueda = Get-Date
    }
    $mb = [math]::Round(((Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
    $serie.Add([pscustomobject]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); mb = $mb })
    Start-Sleep -Milliseconds 500
}
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
    Write-Host ('{0} {1,-86} {2,7:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)) -ForegroundColor $color
    if ($s.detalle) { Write-Host "      -> $($s.detalle)" -ForegroundColor $color }
}
Write-Host ""

# Procesos de TeX que quedaron vivos después de cerrar la app: no tiene que haber ninguno que no estuviera antes.
Start-Sleep -Seconds 2
$tex1 = @(Get-Process pdflatex, latexmk, biber, makeindex -ErrorAction SilentlyContinue).Count
$huerfanos = [math]::Max(0, $tex1 - $tex0)
$memAntes = 'n/d'; $memDespues = 'n/d'; $memPico = 'n/d'
if ($r.recargas -and $serie.Count -gt 0) {
    $antes = @($serie | Where-Object { $_.t -le $r.recargas.inicioMs }) | Select-Object -Last 1
    $despues = @($serie | Where-Object { $_.t -ge $r.recargas.finMs }) | Select-Object -First 1
    $enVentana = @($serie | Where-Object { $_.t -ge $r.recargas.inicioMs -and $_.t -le $r.recargas.finMs })
    if ($antes) { $memAntes = $antes.mb }
    if ($despues) { $memDespues = $despues.mb }
    if ($enVentana.Count -gt 0) {
        $memPico = ($enVentana | Measure-Object mb -Maximum).Maximum
        # Estable es que la segunda mitad no siga subiendo: un cuarto, la mitad y tres cuartos de la ventana.
        $q = 1..3 | ForEach-Object { $enVentana[[int]([math]::Floor($enVentana.Count * $_ / 4))].mb }
        $memCuartos = ($q -join ' / ')
    }
}
if (-not $memCuartos) { $memCuartos = 'n/d' }
Write-Host ("total {0} s   memoria del WebView en las 40 recargas: antes {1} MB, a 1/4, 1/2 y 3/4: {2} MB, pico {3} MB, después {4} MB   procesos de TeX que quedaron vivos: {5}" -f $seg, $memAntes, $memCuartos, $memPico, $memDespues, $huerfanos)
Write-Host ("medidas: " + (($r | Select-Object rapidoFrio, parcialSembrado, sinCambiosMs, parcialGuardarAVer, rapidoGuardarAVer, recargas, partes, indiceMs | ConvertTo-Json -Compress -Depth 4)))
if ($huerfanos -gt 0) { Write-Host "Quedaron procesos de TeX vivos." -ForegroundColor Red }
if ($r.ok -and $huerfanos -eq 0) { Write-Host "SMOKE OK" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
