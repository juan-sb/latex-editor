# Mide la cocción de las figuras del libro con distinta cantidad de subcompilaciones a la vez (F6).
#
# Cada corrida cambia el sello agregando una línea de comentario a estilo_figuras.tex de la COPIA del libro (nunca el de inspo),
# así que las 158 figuras hay que cocinarlas de cero, y corre el motor de la app (`--example build -- <copia> --figuras`). Da el
# tiempo del listado y el de la cocción por separado. Trabaja sobre spikes\work\f6-libro (copia tibia de fixtures\libro-tc).
#
# Uso:  powershell -NoProfile -File scripts\bench-figuras.ps1 [-Trabajos 16,12,8,16]
#
# Necesita la copia armada: scripts\copiar-libro.ps1 -Limpio -Origen fixtures\libro-tc -Destino spikes\work\f6-libro
# y su latexviewer.json (fixtures\configs\libro-tc.latexviewer.json).

param([int[]]$Trabajos = @(16, 12, 8, 16))

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$copia = Join-Path $repo 'spikes\work\f6-libro'
$exe = Join-Path $repo 'target\release\examples\build.exe'
if (-not (Test-Path $copia)) { throw "Falta la copia $copia (ver el encabezado de este script)." }
Push-Location $repo
try { cargo build -q --release -p lv-core --example build } finally { Pop-Location }

$cfgRuta = Join-Path $copia 'latexviewer.json'
$cfgOriginal = [IO.File]::ReadAllText($cfgRuta)
$n = 0
try {
    foreach ($j in $Trabajos) {
        $n++
        # parallelJobs de esta corrida
        $cfg = [regex]::Replace($cfgOriginal, '"parallelJobs"\s*:\s*("auto"|\d+)', "`"parallelJobs`": $j")
        [IO.File]::WriteAllText($cfgRuta, $cfg, (New-Object Text.UTF8Encoding $false))
        [IO.File]::AppendAllText((Join-Path $copia 'estilo_figuras.tex'), "% bench $(Get-Date -Format o) corrida $n`n")
        $t = Get-Date
        # El motor informa por stderr: con `Stop` PowerShell 5.1 toma cada línea como un error.
        $ErrorActionPreference = 'Continue'
        $salida = & $exe $copia --figuras 2>&1 | ForEach-Object { "$_" }
        $ErrorActionPreference = 'Stop'
        $seg = ((Get-Date) - $t).TotalSeconds
        # El motor imprime el aviso de cocción terminada dos veces (evento y resumen): se toma una sola línea de cada.
        $lista = [string](($salida | Where-Object { $_ -match 'listado en' } | Select-Object -First 1) -replace '.*\(listado en ([0-9.]+) s\).*', '$1')
        $coc = [string](($salida | Where-Object { $_ -match 'cocción terminada' } | Select-Object -Last 1) -replace '.*ok=(\w+) cocidas=(\d+) fallidas=(\d+).* ([0-9.]+) s.*', 'ok=$1 cocidas=$2 fallidas=$3 total=$4')
        Write-Host ("{0,2} trabajos: listado {1} s | {2} | reloj {3:N1} s" -f $j, $lista, $coc, $seg)
    }
} finally {
    [IO.File]::WriteAllText($cfgRuta, $cfgOriginal, (New-Object Text.UTF8Encoding $false))
}
