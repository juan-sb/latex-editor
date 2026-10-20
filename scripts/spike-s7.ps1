# Spike S7 (F8c): ¿cuánto ahorra el modo borrador de imágenes (`draftImages`: \PassOptionsToPackage{draft}{graphicx} y {graphics}, lo
# que hace el «Fast [draft]» de Overleaf) en el libro? Compila el rápido DESDE CERO (cleanBefore) con y sin borrador, alternando, y
# compara los dos PDF página a página (scripts\comparar-pdf.py): la paginación tiene que ser la misma y sólo cambian las páginas
# con imagen. Trabaja sobre una copia del libro en spikes\work\s7\ (ignorada por git); inspo\ no se toca.
#
# Uso:  powershell -NoProfile -File scripts\spike-s7.ps1 [-Repeticiones 3]
#
# Necesita el cache tibio de fixtures\libro-tc (scripts\bench-base.ps1) y Python.

param([int]$Repeticiones = 3)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$base = Join-Path $repo 'spikes\work\s7'
$carpeta = Join-Path $base 'Proyecto'
$utf8 = New-Object Text.UTF8Encoding $false

& (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio -Origen 'fixtures\libro-tc' -Destino 'spikes\work\s7\Proyecto' | Out-Null
$sello = (Get-FileHash (Join-Path $carpeta 'estilo_figuras.tex') -Algorithm MD5).Hash.Substring(0, 6)
$cache = Join-Path $carpeta 'figuras-cache'
Get-ChildItem $cache -File | Where-Object { $_.Name -notlike "$sello-*" } | Remove-Item -Force
$basura = '.aux', '.fdb_latexmk', '.fls', '.bbl', '.bcf', '.blg', '.toc', '.idx', '.ilg', '.ind', '.lof', '.lot', '.out', '.log', '.gz', '.auxlock'
Get-ChildItem $carpeta -Recurse -File -Force |
    Where-Object { $_.FullName -notlike "$cache\*" -and ($basura -contains $_.Extension.ToLower() -or $_.Name -like '*.run.xml') } | Remove-Item -Force
if (Test-Path (Join-Path $carpeta '.lv')) { Remove-Item (Join-Path $carpeta '.lv') -Recurse -Force }
& (Join-Path $PSScriptRoot 'parchear-libro-f7.ps1') -Carpeta $carpeta -ExportDir 'export' | Out-Null

# Los dos perfiles de la medición: el mismo rápido, desde cero, con y sin borrador.
$cfgRuta = Join-Path $carpeta 'latexviewer.json'
$cfg = Get-Content $cfgRuta -Raw -Encoding UTF8 | ConvertFrom-Json
$sin = [pscustomobject]@{ label = 'Rápido desde cero'; partial = $true; externalize = $true; parts = 'all'; cleanBefore = $true; autoCompile = $false }
$con = [pscustomobject]@{ label = 'Rápido desde cero, borrador'; partial = $true; externalize = $true; parts = 'all'; cleanBefore = $true; autoCompile = $false; draftImages = $true }
$cfg.profiles | Add-Member -NotePropertyName 'medida' -NotePropertyValue $sin
$cfg.profiles | Add-Member -NotePropertyName 'medidaborrador' -NotePropertyValue $con
[IO.File]::WriteAllText($cfgRuta, ($cfg | ConvertTo-Json -Depth 10), $utf8)

$proc = Start-Process -FilePath 'cargo' -ArgumentList @('build', '--release', '-p', 'lv-core', '--example', 'build') -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $base 'cargo.out.txt') -RedirectStandardError (Join-Path $base 'cargo.err.txt')
if ($proc.ExitCode -ne 0) { throw 'No se pudo compilar el ejemplo build.' }
$exe = Join-Path $repo 'target\release\examples\build.exe'

function Correr($perfil, $n) {
    $err = Join-Path $base "$perfil-$n.err.txt"
    $p = Start-Process -FilePath $exe -ArgumentList @("`"$carpeta`"", $perfil) -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $base "$perfil-$n.out.txt") -RedirectStandardError $err
    $t = Get-Content $err -Raw -Encoding UTF8
    $m = [regex]::Match($t, "== terminó ${perfil}: ok=(\w+).*? (\d+\.\d) s pasadas=(\d+)")
    if ($p.ExitCode -ne 0 -or $m.Groups[1].Value -ne 'true') { throw "El perfil $perfil falló (código $($p.ExitCode)): $err" }
    return [pscustomobject]@{ perfil = $perfil; s = [double]::Parse($m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture); pasadas = [int]$m.Groups[3].Value }
}

$res = @()
for ($i = 1; $i -le $Repeticiones; $i++) {
    foreach ($perfil in 'medida', 'medidaborrador') {
        $r = Correr $perfil $i
        $res += $r
        Write-Host ("{0,-16} corrida {1}: {2,5:N1} s, {3} pasadas" -f $perfil, $i, $r.s, $r.pasadas)
    }
}
function Mediana($v) { $o = $v | Sort-Object; return $o[[math]::Floor($o.Count / 2)] }
$mSin = Mediana ($res | Where-Object { $_.perfil -eq 'medida' } | ForEach-Object { $_.s })
$mCon = Mediana ($res | Where-Object { $_.perfil -eq 'medidaborrador' } | ForEach-Object { $_.s })
Write-Host ("`nmediana sin borrador {0:N1} s, con borrador {1:N1} s: ahorro {2:N1} s ({3:N1} %)" -f $mSin, $mCon, ($mSin - $mCon), (100 * ($mSin - $mCon) / $mSin))

$a = Join-Path $carpeta '.lv\build\medida\lv-medida.pdf'
$b = Join-Path $carpeta '.lv\build\medidaborrador\lv-medidaborrador.pdf'
Write-Host "`nPDF, página a página (60 dpi):"
& python -I (Join-Path $PSScriptRoot 'comparar-pdf.py') $a $b 60 (Join-Path $base 'raster') 2>&1 | ForEach-Object { Write-Host "  $_" }
Write-Host ("tamaño de los PDF: {0:N0} KB sin borrador, {1:N0} KB con borrador" -f ((Get-Item $a).Length / 1KB), ((Get-Item $b).Length / 1KB))
$driver = Get-Content (Join-Path $carpeta '.lv\drivers\lv-medidaborrador.tex') -Encoding UTF8 | Select-String 'PassOptions'
Write-Host "driver del borrador: $($driver -join ' | ')"
