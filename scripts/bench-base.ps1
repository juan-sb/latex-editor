# Línea de base: mide cuánto tarda el libro con los scripts y el latexmkrc de inspo TAL CUAL,
# sobre la copia fixtures\libro-tc. Es la vara contra la que se comparan los perfiles de la app.
#
# De dónde salen los números: el latexmkrc de inspo escribe registro-compilacion.txt con una
# línea INICIO, una por pasada de pdflatex (con sus figuras cocinadas), la cocción en paralelo si
# se disparó y una línea FIN con el total. Acá se lee lo que cada corrida agregó a ese archivo,
# más el reloj de pared de todo el comando.
#
# Escenarios (en este orden; cada uno arranca del estado que dejó el anterior):
#   parcial   cap_actual en frío (cocción de figuras incluida), sin cambios x3, cambio chico x3
#   rapido    libro_fast la primera vez, sin cambios x3, cambio chico x3
#   alternar  parcial -> rapido -> parcial -> rapido sin tocar nada
#   completo  compilar.ps1 -Que completo (limpia antes) y latexmk de nuevo sin cambios
#   estilo    cambio de estilo_figuras.tex (cambia el sello) y después deshacerlo
#
# "Cambio chico" = una palabra nueva en un párrafo de texto plano de Secciones\Desnormalización.tex
# (el capítulo de trabajo del \includeonly de cap_actual). Se restaura el original al terminar.
#
# Antes de medir conviene haber compilado el libro una vez en esta máquina: MiKTeX instala los
# paquetes que le faltan sobre la marcha y esa primera corrida no mide nada útil.
#
# Uso:  powershell -NoProfile -File scripts\bench-base.ps1 [-Escenarios parcial,rapido,...] [-SinCopiar]
#   -SinCopiar  no rehace la copia en frío (sólo para repetir un escenario suelto).
# Salida cruda en scripts\out\ (ignorada por git); los números que valen van a docs\benchmarks.md.

param(
    [string[]]$Escenarios = @('parcial', 'rapido', 'alternar', 'completo', 'estilo'),
    [switch]$SinCopiar,
    [int]$Repeticiones = 3
)

$ErrorActionPreference = 'Stop'
$repo  = Split-Path $PSScriptRoot -Parent
$libro = Join-Path $repo 'fixtures\libro-tc'
$out   = Join-Path $repo 'scripts\out'
$utf8  = New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $SinCopiar) { & powershell -NoProfile -File (Join-Path $PSScriptRoot 'copiar-libro.ps1') -Limpio | Out-Null }
Set-Location $libro

$registro = Join-Path $libro 'registro-compilacion.txt'
$resultados = New-Object System.Collections.Generic.List[object]

# --- Comandos: los mismos que usan compilar.ps1 y la receta de VS Code -----------------------------
$LATEXMK = '-pdf -shell-escape -interaction=nonstopmode -synctex=1'
$cmdParcial = { cmd /c "latexmk $LATEXMK cap_actual.tex > NUL 2>&1" }
$cmdRapido  = { cmd /c "latexmk $LATEXMK libro_fast.tex > NUL 2>&1" }
$cmdCompleto = { powershell -NoProfile -ExecutionPolicy Bypass -File Herramientas\compilar.ps1 -Que completo | Out-Null }
$cmdCompletoSinCambios = { & latexmk -pdf -interaction=nonstopmode -synctex=1 'Funciones de Aproximación.tex' | Out-Null }

# --- Lo que agregó la corrida al registro ------------------------------------------------------------
function Leer-Registro($desde) {
    if (-not (Test-Path $registro)) { return '' }
    $largo = (Get-Item $registro).Length
    if ($largo -lt $desde) { $desde = 0 }   # el registro se rotó a los 300 KB
    $fs = [IO.File]::Open($registro, 'Open', 'Read', 'ReadWrite')
    try {
        $null = $fs.Seek($desde, 'Begin')
        $buf = New-Object byte[] ($largo - $desde)
        $n = $fs.Read($buf, 0, $buf.Length)
        return $utf8.GetString($buf, 0, $n)
    } finally { $fs.Dispose() }
}

function Medir($escenario, $rep, [scriptblock]$cmd) {
    $antes = if (Test-Path $registro) { (Get-Item $registro).Length } else { 0 }
    $reloj = [Diagnostics.Stopwatch]::StartNew()
    & $cmd
    $codigo = $LASTEXITCODE
    $reloj.Stop()
    $t = Leer-Registro $antes

    $pasadas = @([regex]::Matches($t, 'pasada (\d+) de pdflatex: ([\d.]+) s') | ForEach-Object { [double]$_.Groups[2].Value })
    $fin     = [regex]::Match($t, 'FIN\s+([\d.]+) s, (\d+) pasadas, (\d+) figuras cocinadas, c.digo (\d+)')
    $coc     = [regex]::Match($t, 'cocci.n en paralelo: ([\d.]+) s')
    $r = [pscustomobject]@{
        escenario  = $escenario
        rep        = $rep
        reloj_s    = [math]::Round($reloj.Elapsed.TotalSeconds, 1)
        latexmk_s  = if ($fin.Success) { [double]$fin.Groups[1].Value } else { $null }
        pasadas    = $pasadas.Count
        pasadas_s  = ($pasadas | ForEach-Object { $_.ToString('0.0') }) -join ' '
        figuras    = if ($fin.Success) { [int]$fin.Groups[3].Value } else { $null }
        coccion_s  = if ($coc.Success) { [double]$coc.Groups[1].Value } else { $null }
        biber      = ([regex]::Matches($t, '    biber: ')).Count
        codigo     = $codigo
        faltaban   = [regex]::Match($t, 'faltaban: ([^\r\n]*)').Groups[1].Value
    }
    $resultados.Add($r)
    Write-Host ("{0,-24} #{1}  reloj {2,6:N1} s  latexmk {3,6}  pasadas {4}  figuras {5}  cocción {6}  código {7}" -f `
        $escenario, $rep, $r.reloj_s, $r.latexmk_s, $r.pasadas, $r.figuras, $r.coccion_s, $codigo)
    if ($codigo -ne 0) { Write-Host "  ATENCIÓN: la compilación terminó con código $codigo" -ForegroundColor Red }
    $guardado = $resultados | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText((Join-Path $out 'bench-base.json'), $guardado, $utf8)
}

# --- Edición de prueba -----------------------------------------------------------------------------------
$rutaCap  = Join-Path $libro 'Secciones\Desnormalización.tex'
$capOriginal = [IO.File]::ReadAllBytes($rutaCap)
$textoCap = $utf8.GetString($capOriginal)
$ancla = 'Las secciones anteriores estudiaron'
if (-not $textoCap.Contains($ancla)) { throw "No encuentro el párrafo de prueba en Desnormalización.tex." }
function Editar-Capitulo($n) {
    # Una palabra nueva en un párrafo de texto plano. Se pisa siempre sobre el original, así
    # cada repetición cambia algo respecto de la anterior.
    $nuevo = $textoCap.Replace($ancla, "Las bench$n secciones anteriores estudiaron")
    [IO.File]::WriteAllText($rutaCap, $nuevo, $utf8)
}
function Restaurar-Capitulo { [IO.File]::WriteAllBytes($rutaCap, $capOriginal) }

$rutaEstilo = Join-Path $libro 'estilo_figuras.tex'
$estiloOriginal = [IO.File]::ReadAllBytes($rutaEstilo)
function Cambiar-Estilo { [IO.File]::AppendAllText($rutaEstilo, "`r`n% bench-estilo`r`n", $utf8) }
function Restaurar-Estilo { [IO.File]::WriteAllBytes($rutaEstilo, $estiloOriginal) }

function Asentar([scriptblock]$cmd) { & $cmd }   # una corrida que no se anota

try {
    if ($Escenarios -contains 'parcial') {
        Medir 'parcial_frio' 1 $cmdParcial
        1..$Repeticiones | ForEach-Object { Medir 'parcial_sin_cambios' $_ $cmdParcial }
        1..$Repeticiones | ForEach-Object { Editar-Capitulo $_; Medir 'parcial_cambio' $_ $cmdParcial }
        Restaurar-Capitulo; Asentar $cmdParcial
    }
    if ($Escenarios -contains 'rapido') {
        Medir 'rapido_primera' 1 $cmdRapido
        1..$Repeticiones | ForEach-Object { Medir 'rapido_sin_cambios' $_ $cmdRapido }
        1..$Repeticiones | ForEach-Object { Editar-Capitulo $_; Medir 'rapido_cambio' $_ $cmdRapido }
        Restaurar-Capitulo; Asentar $cmdRapido; Asentar $cmdParcial
    }
    if ($Escenarios -contains 'alternar') {
        # Los dos ya están al día y nada cambió: cada pasada que aparezca acá es costo de alternar.
        Asentar $cmdParcial; Asentar $cmdRapido
        1..2 | ForEach-Object {
            Medir 'alternar_parcial' $_ $cmdParcial
            Medir 'alternar_rapido'  $_ $cmdRapido
        }
    }
    if ($Escenarios -contains 'completo') {
        Medir 'completo_limpio' 1 $cmdCompleto
        1..2 | ForEach-Object { Medir 'completo_sin_cambios' $_ $cmdCompletoSinCambios }
    }
    if ($Escenarios -contains 'estilo') {
        Asentar $cmdParcial
        Cambiar-Estilo
        Medir 'estilo_cambio' 1 $cmdParcial
        Medir 'estilo_cambio_sin_mas' 1 $cmdParcial
        Restaurar-Estilo
        Medir 'estilo_deshacer' 1 $cmdParcial
    }
} finally {
    # Pase lo que pase, la copia queda con los fuentes originales.
    Restaurar-Capitulo
    Restaurar-Estilo
}

# --- Resumen por escenario: mediana y rango del reloj de pared ----------------------------------------
function Mediana($v) { $s = @($v | Sort-Object); if ($s.Count -eq 0) { return $null }; $m = [int][math]::Floor($s.Count / 2); if ($s.Count % 2) { $s[$m] } else { ($s[$m - 1] + $s[$m]) / 2 } }
$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine('| Escenario | n | Reloj mediana (s) | Rango (s) | Pasadas | Figuras cocinadas | Cocción paralela (s) |')
[void]$md.AppendLine('|---|---|---|---|---|---|---|')
foreach ($g in ($resultados | Group-Object escenario)) {
    $rel = $g.Group | ForEach-Object { $_.reloj_s }
    $coc = @($g.Group | Where-Object { $null -ne $_.coccion_s } | ForEach-Object { $_.coccion_s })
    [void]$md.AppendLine(('| {0} | {1} | {2:N1} | {3:N1} a {4:N1} | {5} | {6} | {7} |' -f `
        $g.Name, $g.Count, (Mediana $rel), ($rel | Measure-Object -Minimum).Minimum, ($rel | Measure-Object -Maximum).Maximum,
        (($g.Group | ForEach-Object { $_.pasadas }) -join ' / '),
        (($g.Group | ForEach-Object { $_.figuras }) -join ' / '),
        $(if ($coc.Count) { ($coc -join ' / ') } else { '' })))
}
[IO.File]::WriteAllText((Join-Path $out 'bench-base.md'), $md.ToString(), $utf8)
Write-Host ""
Write-Host $md.ToString()
