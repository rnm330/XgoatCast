$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'XgoatCast.exe'
if (!(Test-Path $exe)) { throw 'Keep this script beside XgoatCast.exe in a permanent folder.' }
$protocolKey = 'HKCU:\Software\Classes\xgoatcast'
$existing = Get-ItemProperty ($protocolKey + '\shell\open\command') -ErrorAction SilentlyContinue
if ($existing -and $existing.'(default)' -ne ('"' + $exe + '" "%1"')) { throw 'Another XgoatCast protocol registration exists. Uninstall it before registering this copy.' }
New-Item $protocolKey -Force | Out-Null
Set-Item $protocolKey 'URL:XgoatCast Protocol'
New-ItemProperty $protocolKey -Name 'URL Protocol' -Value '' -Force | Out-Null
New-Item ($protocolKey + '\shell\open\command') -Force | Out-Null
Set-Item ($protocolKey + '\shell\open\command') ('"' + $exe + '" "%1"')
New-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name XgoatCast -Value ('"' + $exe + '" --tray') -PropertyType String -Force | Out-Null
Start-Process $exe -ArgumentList '--tray'
Write-Host 'XgoatCast registered for this Windows user. Return to the sharing page.'
