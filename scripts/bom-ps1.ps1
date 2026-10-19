# Deja con BOM UTF-8 todos los .ps1 del repo (scripts\ y spikes\). Es idempotente.
#
# Por qué: Windows PowerShell 5.1 lee como ANSI un script UTF-8 sin BOM, y los acentos de los
# mensajes salen rotos ("frÃ­o"). Write y Edit guardan sin BOM, así que hay que correr esto
# después de crear o editar un .ps1. Los scripts de inspo ya vienen con BOM.
#
# Uso:  powershell -NoProfile -File scripts\bom-ps1.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$conBom = New-Object Text.UTF8Encoding $true
$sinBom = New-Object Text.UTF8Encoding $false
$cambiados = 0

foreach ($carpeta in 'scripts', 'spikes') {
    $ruta = Join-Path $repo $carpeta
    if (-not (Test-Path $ruta)) { continue }
    # node_modules y target son de terceros y se regeneran: no se tocan.
    foreach ($f in Get-ChildItem $ruta -Recurse -Filter *.ps1 -File | Where-Object { $_.FullName -notmatch '\\(node_modules|target|work)\\' }) {
        $b = [IO.File]::ReadAllBytes($f.FullName)
        if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { continue }
        [IO.File]::WriteAllText($f.FullName, [IO.File]::ReadAllText($f.FullName, $sinBom), $conBom)
        $cambiados++
        Write-Host "BOM agregado: $($f.FullName.Substring($repo.Length + 1))"
    }
}
Write-Host "Listo: $cambiados archivo(s) cambiados."
