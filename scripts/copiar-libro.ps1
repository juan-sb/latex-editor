# Copia el libro a una carpeta de trabajo, que es sobre lo que corren los tests y los
# benchmarks. Acá inspo\ sólo se lee: desde F9 tiene su propio repo (inspo\.git) y la copia por omisión sale
# de lo VERSIONADO en el tag pre-f9 (`git read-tree` y `checkout-index`), no del árbol de trabajo: así el libro que miden los
# benchmarks es siempre el mismo, aunque el autor o la app dejen archivos sueltos o se migre el libro.
#
# El latexmkrc del libro tiene $out_dir = '../PDF', así que compilando una copia los PDF caen en
# la carpeta PDF hermana (para la copia por omisión, fixtures\PDF). No se toca el latexmkrc de la
# copia: la línea de base se mide con los scripts de inspo tal cual.
#
# Uso:  powershell -NoProfile -File scripts\copiar-libro.ps1 [-Limpio] [-Destino <ruta>] [-Origen inspo|<ruta>] [-Rev <tag>]
#   -Limpio   borra antes el destino y su carpeta PDF hermana, para arrancar en frío (sin
#             figuras-cache, sin .aux, sin PDF).
#   -Destino  carpeta de la copia, relativa al repo. Por omisión fixtures\libro-tc. Tiene que
#             caer adentro de fixtures\ o de spikes\work\ (así -Limpio nunca puede borrar otra cosa).
#   -Origen   de dónde se copia. Por omisión el libro de inspo\ en la revisión -Rev. Con la ruta de otra copia (por
#             ejemplo fixtures\libro-tc) se lleva también su cache de figuras y sus auxiliares,
#             y la carpeta PDF hermana, para arrancar un spike con todo tibio.
#   -Rev      revisión de inspo\ de la que sale la copia (por omisión pre-f9). Sin figuras-cache ni auxiliares:
#             es sólo lo versionado, así que el cache se arma con bench-base.ps1.
#
# Sin -Limpio, robocopy deja en la copia lo que ya había (no usa /MIR a propósito: así no se
# pierde el cache ni los auxiliares entre corridas de un mismo benchmark).

param(
    [switch]$Limpio,
    [string]$Destino = 'fixtures\libro-tc',
    [string]$Origen = 'inspo',
    [string]$Rev = 'pre-f9'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

$origenCopia = ($Origen -ne 'inspo')
$origen  = if ($origenCopia) { [IO.Path]::GetFullPath((Join-Path $repo $Origen)) } else { $null }
$destino = [IO.Path]::GetFullPath((Join-Path $repo $Destino))
$pdfs    = Join-Path (Split-Path $destino -Parent) 'PDF'

if ($origenCopia -and -not (Test-Path $origen)) { throw "No existe $origen." }

# El libro de inspo\: lo versionado en $Rev, extraído a una carpeta temporal (inspo\ no se toca).
$extraido = $null
if (-not $origenCopia) {
    $gitInspo = Join-Path $repo 'inspo\.git'
    if (-not (Test-Path $gitInspo)) { throw "inspo\ no tiene repo (inspo\.git): ¿se hizo el paso 0 de F9?" }
    $extraido = Join-Path ([IO.Path]::GetTempPath()) ('lv-libro-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $extraido | Out-Null
    # Con un índice temporal: `git archive | tar` rompe los nombres con tildes (tar los lee con la página de códigos de la consola, se probó:
    # «Funciones de Aproximación.tex» quedaba como «Funciones de Aproximaci├│n.tex») y un `checkout` común pisaría el índice de inspo\.
    $indice = Join-Path $extraido 'indice'
    $env:GIT_INDEX_FILE = $indice
    try {
        & git --git-dir $gitInspo read-tree $Rev
        if ($LASTEXITCODE -ne 0) { throw "git read-tree $Rev falló (código $LASTEXITCODE)." }
        & git --git-dir $gitInspo --work-tree $extraido checkout-index -a
        if ($LASTEXITCODE -ne 0) { throw "git checkout-index falló (código $LASTEXITCODE)." }
    } finally {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    }
    $origen = Join-Path $extraido 'Proyecto'
}

# Sólo se escribe y se borra adentro de fixtures\ o spikes\work\ del repo. Nunca en inspo\.
# (Los paréntesis importan: en PowerShell la coma pesa más que "+".)
$permitidos = @( ((Join-Path $repo 'fixtures') + '\'), ((Join-Path $repo 'spikes\work') + '\') )
foreach ($d in @($destino, $pdfs)) {
    if (-not ($permitidos | Where-Object { $d.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
        throw "Ruta fuera de fixtures\ y spikes\work\: $d"
    }
}

if ($Limpio) {
    foreach ($d in @($destino, $pdfs)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
}

New-Item -ItemType Directory -Force $destino | Out-Null

# /E subcarpetas (con las vacías), /NFL /NDL /NJH /NJS /NP salida mínima, /R:1 /W:1 sin esperas largas.
# Los .git de adentro (si los hubiera) no se copian.
robocopy $origen $destino /E /XD '.git' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
# robocopy devuelve 0 a 7 cuando salió bien; 8 o más es error.
if ($LASTEXITCODE -ge 8) { throw "robocopy falló con código $LASTEXITCODE." }

# Si se copia de otra copia, la carpeta PDF hermana (donde latexmk dejó los PDF y su synctex) va
# con ella: sin eso, latexmk no encuentra los PDF que espera y rehace pasadas.
if ($origenCopia) {
    $pdfsOrigen = Join-Path (Split-Path $origen -Parent) 'PDF'
    if (Test-Path $pdfsOrigen) {
        New-Item -ItemType Directory -Force $pdfs | Out-Null
        robocopy $pdfsOrigen $pdfs /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy de PDF falló con código $LASTEXITCODE." }
    }
}
if ($extraido) { Remove-Item $extraido -Recurse -Force }
$global:LASTEXITCODE = 0

$n = (Get-ChildItem $destino -Recurse -File -Force | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $destino -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ("Copia lista: {0} ({1} archivos, {2} MB){3}" -f $destino, $n, $mb, $(if ($Limpio) { ', en frío' } else { '' }))
exit 0
