# Prepara una COPIA del libro para probar F7 (nunca inspo ni fixtures\libro-tc): le pone la guardia a \OpcionPie en structure.tex,
# para que el valor que elige el menú de compilación (el driver lo define antes de cargar la raíz) no lo pise el \def incondicional
# del libro, y le copia el latexviewer.json del repo (con la variable y la exportación). El libro real se corrige en F9.
#
# Uso:  powershell -NoProfile -File scripts\parchar-libro-f7.ps1 -Carpeta spikes\work\f6-libro [-ExportDir export]
#
# -ExportDir cambia `export.dir` del latexviewer.json de la copia (el del repo es `../PDF/Capítulos`, afuera de la copia).

param(
    [Parameter(Mandatory = $true)][string]$Carpeta,
    [string]$ExportDir = '',
    # No toca structure.tex: el libro queda como está, con su \def incondicional (lo usa el smoke de F8, donde el doctor tiene que verlo).
    [switch]$SinGuardia
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$carpeta = (Resolve-Path $Carpeta).Path
$utf8 = New-Object Text.UTF8Encoding $false

$structure = Join-Path $carpeta 'structure.tex'
$t = [IO.File]::ReadAllText($structure, $utf8)
$sin = '\def\OpcionPie{completo}'
$con = '\ifdefined\OpcionPie\else\def\OpcionPie{completo}\fi'
if ($SinGuardia) {
    Write-Host 'structure.tex: sin tocar (sin guardia).'
} elseif ($t.Contains($con)) {
    Write-Host 'structure.tex: la guardia ya estaba.'
} elseif ($t.Contains($sin)) {
    [IO.File]::WriteAllText($structure, $t.Replace($sin, $con), $utf8)
    Write-Host 'structure.tex: guardia puesta a \OpcionPie.'
} else {
    throw 'structure.tex no tiene el \def de \OpcionPie que se esperaba.'
}

$cfg = [IO.File]::ReadAllText((Join-Path $repo 'fixtures\configs\libro-tc.latexviewer.json'), $utf8)
if ($ExportDir) { $cfg = $cfg.Replace('"dir": "../PDF/Capítulos"', '"dir": "' + $ExportDir + '"') }
[IO.File]::WriteAllText((Join-Path $carpeta 'latexviewer.json'), $cfg, $utf8)
Write-Host "latexviewer.json copiado a $carpeta."
