# Compila cada fixture chico de fixtures\ con latexmk y falla si alguno no da PDF o si quedó
# con referencias o citas sin resolver (un "??" en el PDF). Es la verificación de que los
# fixtures sirven y de que el toolchain de esta máquina anda.
#
# Cada caso arranca con "latexmk -C", así el resultado no depende de corridas anteriores.
# libro-tc (la copia del libro) no entra acá: lo miden los benchmarks.
#
# Uso:  powershell -NoProfile -File scripts\compilar-fixtures.ps1 [-Solo <nombre>]

param([string]$Solo)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$fix  = Join-Path $repo 'fixtures'

# Nombre, carpeta, raíz y flags extra de latexmk. El engine de xelatex lo fija su latexmkrc.
$casos = @(
    @{ n = 'articulo-simple';      d = 'articulo-simple'; raiz = 'main.tex';     extra = '-pdf' },
    @{ n = 'libro-include';        d = 'libro-include';   raiz = 'main.tex';     extra = '-pdf' },
    @{ n = 'biblio-indice';        d = 'biblio-indice';   raiz = 'main.tex';     extra = '-pdf' },
    @{ n = 'tikz-figuras';         d = 'tikz-figuras';    raiz = 'main.tex';     extra = '-pdf' },
    @{ n = 'tikz-figuras (cache)'; d = 'tikz-figuras';    raiz = 'main-ext.tex'; extra = '-pdf -shell-escape' },
    @{ n = 'xelatex';              d = 'xelatex';         raiz = 'main.tex';     extra = '' }
)
if ($Solo) { $casos = @($casos | Where-Object { $_.n -like "$Solo*" }) }

$fallos = @()
foreach ($c in $casos) {
    $dir = Join-Path $fix $c.d
    $base = [IO.Path]::GetFileNameWithoutExtension($c.raiz)
    $pdf = Join-Path $dir "$base.pdf"
    $log = Join-Path $dir "$base.log"
    $salida = Join-Path $env:TEMP "lv-fixture-$($c.d)-$base.txt"

    Push-Location $dir
    try {
        # cmd /c con la redirección adentro: en Windows PowerShell 5.1, "2>&1" sobre un ejecutable
        # nativo convierte cada línea de stderr en un error.
        cmd /c "latexmk -C $($c.raiz) > NUL 2>&1"
        if (Test-Path 'figuras-cache') { Remove-Item 'figuras-cache' -Recurse -Force }
        $reloj = [Diagnostics.Stopwatch]::StartNew()
        cmd /c "latexmk $($c.extra) -interaction=nonstopmode -file-line-error $($c.raiz) > `"$salida`" 2>&1"
        $codigo = $LASTEXITCODE
        $reloj.Stop()
    } finally { Pop-Location }

    $problema = $null
    if ($codigo -ne 0) { $problema = "latexmk salió con código $codigo" }
    elseif (-not (Test-Path $pdf)) { $problema = 'no se generó el PDF' }
    elseif ((Test-Path $log) -and (Select-String -Path $log -Pattern 'There were undefined references|Citation .* undefined|LaTeX Warning: Reference .* undefined' -Quiet)) {
        $problema = 'quedaron referencias o citas sin resolver'
    }

    if ($problema) {
        Write-Host ("FALLA  {0,-22} {1}  (salida: {2})" -f $c.n, $problema, $salida) -ForegroundColor Red
        $fallos += $c.n
    } else {
        Write-Host ("ok     {0,-22} {1,5:N1} s" -f $c.n, $reloj.Elapsed.TotalSeconds) -ForegroundColor Green
    }
}

if ($fallos.Count -gt 0) { Write-Host ("Fallaron: " + ($fallos -join ', ')) -ForegroundColor Red; exit 1 }
Write-Host "Todos los fixtures compilan."
exit 0
