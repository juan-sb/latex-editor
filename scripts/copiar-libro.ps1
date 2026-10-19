# Copia el libro a una carpeta de trabajo, que es sobre lo que corren los tests y los
# benchmarks. inspo\ no se modifica nunca: acá sólo se lee.
#
# El latexmkrc del libro tiene $out_dir = '../PDF', así que compilando una copia los PDF caen en
# la carpeta PDF hermana (para la copia por omisión, fixtures\PDF). No se toca el latexmkrc de la
# copia: la línea de base se mide con los scripts de inspo tal cual.
#
# Uso:  powershell -NoProfile -File scripts\copiar-libro.ps1 [-Limpio] [-Destino <ruta>] [-Origen inspo|<ruta>]
#   -Limpio   borra antes el destino y su carpeta PDF hermana, para arrancar en frío (sin
#             figuras-cache, sin .aux, sin PDF).
#   -Destino  carpeta de la copia, relativa al repo. Por omisión fixtures\libro-tc. Tiene que
#             caer adentro de fixtures\ o de spikes\work\ (así -Limpio nunca puede borrar otra cosa).
#   -Origen   de dónde se copia. Por omisión inspo\Proyecto. Con la ruta de otra copia (por
#             ejemplo fixtures\libro-tc) se lleva también su cache de figuras y sus auxiliares,
#             y la carpeta PDF hermana, para arrancar un spike con todo tibio.
#
# Sin -Limpio, robocopy deja en la copia lo que ya había (no usa /MIR a propósito: así no se
# pierde el cache ni los auxiliares entre corridas de un mismo benchmark).

param(
    [switch]$Limpio,
    [string]$Destino = 'fixtures\libro-tc',
    [string]$Origen = 'inspo'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

$origenCopia = ($Origen -ne 'inspo')
$origen  = if ($origenCopia) { [IO.Path]::GetFullPath((Join-Path $repo $Origen)) } else { Join-Path $repo 'inspo\Proyecto' }
$destino = [IO.Path]::GetFullPath((Join-Path $repo $Destino))
$pdfs    = Join-Path (Split-Path $destino -Parent) 'PDF'

if (-not (Test-Path $origen)) { throw "No existe $origen." }

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
$global:LASTEXITCODE = 0

$n = (Get-ChildItem $destino -Recurse -File -Force | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $destino -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ("Copia lista: {0} ({1} archivos, {2} MB){3}" -f $destino, $n, $mb, $(if ($Limpio) { ', en frío' } else { '' }))
exit 0
