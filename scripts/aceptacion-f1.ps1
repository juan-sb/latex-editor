# Smoke de aceptación de F1: abre el proyecto en la app, edita un capítulo con un marcador, guarda comparando los bytes de
# disco, compila el completo, busca el marcador en el PDF, revierte y comprueba los bytes originales.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f1.ps1 [-Proyecto libro-tc|libro-include|articulo-simple] [-LimiteMin 20]
#   libro-tc          el libro de verdad (copia fresca en frío): el criterio de aceptación de plan.md. Tarda ~6 minutos.
#   libro-include     fixture CRLF con \include en subcarpetas con tildes: es el que prueba "no alterar el CRLF". Segundos.
#   articulo-simple   fixture mínimo. Segundos.
#
# Necesita la app compilada: npx tauri build --no-bundle (deja target\release\lv-app.exe). Trabaja siempre sobre una copia
# en spikes\work\ (ignorada por git); inspo\ no se toca. Sale con 0 si el smoke dio ok.

param(
    [ValidateSet('libro-tc', 'libro-include', 'articulo-simple')][string]$Proyecto = 'libro-tc',
    [int]$LimiteMin = 20,
    # Milisegundos que la app deja la interfaz abierta al terminar: alcanza para medir la memoria con el PDF cargado y,
    # si es más largo, para sacarle una captura de pantalla.
    [int]$PausaMs = 4000
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

$base = Join-Path $repo "spikes\work\f1-smoke-$Proyecto"
$carpeta = Join-Path $base 'Proyecto'
$salida = Join-Path $base 'resultado.json'
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Force $base | Out-Null

switch ($Proyecto) {
    'libro-tc' {
        & (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Destino "spikes\work\f1-smoke-libro-tc\Proyecto" | Out-Null
        $raiz = 'Funciones de Aproximación.tex'
        $archivo = 'Secciones/Desnormalización.tex'
    }
    default {
        # Se copia el fixture sin lo que dejó una compilación anterior.
        robocopy (Join-Path $repo "fixtures\$Proyecto") $carpeta /E /XD figuras-cache .lv /XF *.aux *.log *.pdf *.fls *.fdb_latexmk *.synctex.gz *.bbl *.bcf *.blg *.idx *.ind *.ilg *.toc *.out *.auxlock /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy falló ($LASTEXITCODE)" }
        $raiz = 'main.tex'
        $archivo = if ($Proyecto -eq 'libro-include') { 'Capítulos/Introducción general.tex' } else { 'main.tex' }
    }
}

$env:LV_SMOKE = '1'
$env:LV_OPEN = $carpeta
$env:LV_ROOT = $raiz
$env:LV_SMOKE_FILE = $archivo
$env:LV_SMOKE_OUT = $salida
if ($PausaMs -gt 0) { $env:LV_SMOKE_PAUSA_MS = "$PausaMs" } else { Remove-Item Env:LV_SMOKE_PAUSA_MS -ErrorAction SilentlyContinue }

Write-Host "Smoke de F1 sobre $Proyecto ($archivo, raíz $raiz)..."
$t = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$limite = (Get-Date).AddMinutes($LimiteMin)
$memoriaMb = $null
while (-not $p.HasExited -and (Get-Date) -lt $limite) {
    # En cuanto la app deja el resultado (y antes de cerrar, por la pausa) se mide la memoria de todo su árbol de
    # procesos, WebView2 incluido, con el PDF cargado.
    if ($null -eq $memoriaMb -and (Test-Path $salida)) {
        $todos = Get-CimInstance Win32_Process
        $ids = @($p.Id)
        do {
            $nuevos = @($todos | Where-Object { ($ids -contains $_.ParentProcessId) -and ($ids -notcontains $_.ProcessId) } | ForEach-Object { $_.ProcessId })
            $ids += $nuevos
        } while ($nuevos.Count -gt 0)
        $memoriaMb = [math]::Round((($todos | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)
    }
    Start-Sleep -Milliseconds 400
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
    $linea = '{0} {1,-78} {2,8:N1} s' -f $marca, $s.nombre, ($s.ms / 1000)
    if ($s.detalle) { $linea += "  -> $($s.detalle)" }
    Write-Host $linea -ForegroundColor $color
}
Write-Host ""
Write-Host ("formato del archivo: {0}   build: {1} ({2} s, código {3})   páginas: {4}   marcador en la página: {5}   total {6} s" -f `
    ($r.formato | ConvertTo-Json -Compress), $r.buildStatus, ([math]::Round($r.buildMs / 1000, 1)), $r.buildCodigo, $r.paginas, $r.paginaDelMarcador, $seg)
Write-Host ("arranque hasta proyecto abierto: {0} ms   memoria del árbol de procesos con el PDF cargado: {1} MB" -f $r.arranqueMs, $(if ($memoriaMb) { $memoriaMb } else { 'n/d' }))
if ($r.ok) { Write-Host "SMOKE OK" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE FALLÓ: $($r.fallo)" -ForegroundColor Red
exit 1
