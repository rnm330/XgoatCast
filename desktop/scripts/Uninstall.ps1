$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'XgoatCast.exe'
$key = 'HKCU:\Software\Classes\xgoatcast'
$command = Get-ItemProperty ($key + '\shell\open\command') -ErrorAction SilentlyContinue
if ($command -and $command.'(default)' -eq ('"' + $exe + '" "%1"')) { Remove-Item -LiteralPath $key -Recurse }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$run = Get-ItemProperty $runKey -Name XgoatCast -ErrorAction SilentlyContinue
if ($run -and $run.XgoatCast -eq ('"' + $exe + '" --tray')) { Remove-ItemProperty $runKey -Name XgoatCast }
Write-Host 'Protocol and startup registration removed for this copy. Exit the tray app before removing its folder.'
