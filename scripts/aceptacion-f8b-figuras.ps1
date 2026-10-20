# Aceptación de F8b, bloque 1 (robustez del cache de figuras), con TeX de verdad y sin interfaz (el motor de la app vía
# `--example build`). El caso de inspo: una copia del libro con el cache a medio llenar (faltan las 8 figuras de Butterworth) y la
# lista de figuras armada con todas las partes. Compilar el parcial con Butterworth NO tiene que dejar que pgf cocine las 8 de a
# una dentro de la pasada (30 s en inspo): se cocinan antes, en paralelo, y el build lanza 0 subcompilaciones.
#
# Uso:  powershell -NoProfile -File scripts\aceptacion-f8b-figuras.ps1
#
# Necesita el cache tibio de fixtures\libro-tc (lo deja bench-base.ps1). Trabaja sobre una copia en spikes\work\f8b-figuras\
# (ignorada por git); inspo\ no se toca. Sale con 0 si todo dio ok.

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$base = Join-Path $repo 'spikes\work\f8b-figuras'
$carpeta = Join-Path $base 'Proyecto'
$utf8 = New-Object Text.UTF8Encoding $false
$parte = 'Secciones/Aproximación de Butterworth'

& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\f8b-figuras\Proyecto' | Out-Null
$sello = (Get-FileHash (Join-Path $carpeta 'estilo_figuras.tex') -Algorithm MD5).Hash.Substring(0, 6)
$cache = Join-Path $carpeta 'figuras-cache'
if (@(Get-ChildItem $cache -File | Where-Object { $_.Name -like "$sello-*" }).Count -eq 0) { throw "El cache de fixtures\libro-tc no tiene figuras del sello ${sello}: corré antes scripts\bench-base.ps1." }
Get-ChildItem $cache -File | Where-Object { $_.Name -notlike "$sello-*" } | Remove-Item -Force
$basura = '.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind', '.lof', '.lot', '.out', '.log', '.gz', '.auxlock'
Get-ChildItem $carpeta -Recurse -File -Force |
    Where-Object { $_.FullName -notlike "$cache\*" -and $_.FullName -notlike "$carpeta\.lv\*" -and ($basura -contains $_.Extension.ToLower() -or $_.Name -like '*.run.xml') } |
    Remove-Item -Force
if (Test-Path (Join-Path $carpeta '.lv')) { Remove-Item (Join-Path $carpeta '.lv') -Recurse -Force }
& (Join-Path $PSScriptRoot 'parchear-libro-f7.ps1') -Carpeta $carpeta -ExportDir 'export' | Out-Null

# Lanza un ejecutable y deja su salida y sus errores en archivos (con `2>` desde PowerShell 5.1, cada línea de stderr se vuelve un
# NativeCommandError). Devuelve el código de salida.
function Correr($exe, [string[]]$argumentos, $salida, $errores) {
    $p = Start-Process -FilePath $exe -ArgumentList $argumentos -NoNewWindow -Wait -PassThru -RedirectStandardOutput $salida -RedirectStandardError $errores
    return $p.ExitCode
}

Push-Location $repo
try {
    Write-Host 'Compilo el motor...'
    $c = Correr 'cargo' @('build', '--release', '-p', 'lv-core', '--example', 'build') (Join-Path $base 'cargo.out.txt') (Join-Path $base 'cargo.err.txt')
    if ($c -ne 0) { throw 'No se pudo compilar el ejemplo build.' }
    $exe = Join-Path $repo 'target\release\examples\build.exe'
    if (-not (Test-Path $exe)) { throw 'No se pudo compilar el ejemplo build.' }

    # 1) Una lista completa (con la raíz y todas las partes): lo que dejaría una cocción manual.
    Write-Host '1) listado de todo el documento (cache tibio: sólo lista)...'
    $t = Get-Date
    Correr $exe @("`"$carpeta`"", '--figuras') (Join-Path $base 'listado.out.txt') (Join-Path $base 'listado.err.txt') | Out-Null
    $listado = [int]((Get-Date) - $t).TotalSeconds
    $fig = Get-Content (Join-Path $carpeta '.lv\figlist.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ("   figlist: {0} figuras, completa={1}, raíz={2}, {3} partes ({4} s)" -f $fig.nombres.Count, $fig.completa, $fig.raiz, $fig.partes.Count, $listado)
    if (-not $fig.completa -or $fig.raiz -ne 'Funciones de Aproximación.tex' -or $fig.partes.Count -ne 8) { throw 'La figlist no quedó completa, con la raíz y las 8 partes.' }

    # 2) Como el cache de inspo: faltan las figuras de Butterworth (PDF, md5, log y dpth).
    $borradas = @(Get-ChildItem $cache -File | Where-Object { $_.Name -like "$sello-butter-*" })
    $borradas | Remove-Item -Force
    $pdfsButter = @($fig.nombres | Where-Object { $_ -like "*$sello-butter-*" }).Count
    Write-Host ("2) borradas las figuras de Butterworth: {0} archivos, {1} figuras" -f $borradas.Count, $pdfsButter)

    # 3) El parcial con Butterworth.
    Write-Host '3) parcial con Butterworth...'
    $salida = Join-Path $base 'parcial.out.txt'
    $errores = Join-Path $base 'parcial.err.txt'
    $t = Get-Date
    $codigo = Correr $exe @("`"$carpeta`"", 'parcial', '--parts', "`"$parte`"") $salida $errores
    $seg = ((Get-Date) - $t).TotalSeconds
    $err = Get-Content $errores -Raw -Encoding UTF8
    $out = Get-Content $salida -Raw -Encoding UTF8
    $listando = [regex]::Match($err, '== listando las figuras \(perfil parcial\)').Success
    $cocinando = [regex]::Match($err, '== cocinando \(perfil parcial\): (\d+) de')
    $dentro = ([regex]::Matches($out, '-jobname "figuras-cache/')).Count
    $terminado = [regex]::Match($err, '== terminó parcial: ok=(\w+)')
    Write-Host ("   código {0}; listó las del perfil: {1}; cocinó antes: {2}; subcompilaciones adentro del build: {3}; total {4:N1} s" -f $codigo, $listando, $cocinando.Groups[1].Value, $dentro, $seg)
    $ok = $true
    if ($codigo -ne 0 -or $terminado.Groups[1].Value -ne 'true') { Write-Host '   el parcial no terminó bien.' -ForegroundColor Red; $ok = $false }
    if (-not $listando -or $cocinando.Groups[1].Value -ne "$pdfsButter") { Write-Host "   tenía que cocinar antes las $pdfsButter figuras de Butterworth." -ForegroundColor Red; $ok = $false }
    if ($dentro -ne 0) { Write-Host '   pgf cocinó figuras adentro del build.' -ForegroundColor Red; $ok = $false }

    # 4) El historial dice por qué.
    $hist = @(Get-Content (Join-Path $carpeta '.lv\history.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
    $build = $hist | Where-Object { $_.tipo -eq 'build' -and $_.perfil -eq 'parcial' } | Select-Object -Last 1
    Write-Host ("4) historial del build: listado = {0}" -f ($build.listado | ConvertTo-Json -Compress))
    if (-not ($build.listado.motivo -like '*faltan 8 figuras de las partes del perfil*')) { Write-Host '   el historial no dice que faltaban figuras de las partes del perfil.' -ForegroundColor Red; $ok = $false }

    # 5) Con todo al día, el parcial siguiente no cocina ni lista antes.
    Write-Host '5) otra vez el parcial (todo al día)...'
    Correr $exe @("`"$carpeta`"", 'parcial', '--parts', "`"$parte`"") $salida $errores | Out-Null
    $err2 = Get-Content $errores -Raw -Encoding UTF8
    if ($err2 -match 'listando las figuras \(perfil parcial\)' -and $err2 -match 'cocinando \(perfil parcial\)') { Write-Host '   volvió a listar antes del build.' -ForegroundColor Red; $ok = $false }
} finally {
    Pop-Location
}
if ($ok) { Write-Host 'ACEPTACION OK' -ForegroundColor Green; exit 0 }
Write-Host 'ACEPTACION FALLÓ' -ForegroundColor Red
exit 1
