# Check: the uninstaller removes what the installer added.

param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
$product = (Get-Content package.json -Raw | ConvertFrom-Json).productName
$problems = New-Object System.Collections.Generic.List[string]
$uninstaller = Join-Path $InstallDir "Uninstall $product.exe"
if (-not (Test-Path $uninstaller)) {
  "detail=the uninstaller is missing" >> $env:GITHUB_OUTPUT
  Write-Output "::error title=Uninstaller missing::$uninstaller does not exist."
  exit 1
}

# Make sure no copy of the app is still running; the uninstaller refuses to remove a running app.
Get-Process -Name $product -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# _?= makes the uninstaller run in place and wait, instead of copying itself to a temp folder and returning at once.
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S', "_?=$InstallDir" -PassThru -Wait
if ($process.ExitCode -ne 0) { $problems.Add("the uninstaller exited with code $($process.ExitCode)") }

$exe = Join-Path $InstallDir "$product.exe"
for ($i = 0; $i -lt 30 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 2 }
if (Test-Path $exe) { $problems.Add("$product.exe is still present after uninstalling") }

$entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like "$product*" } | Select-Object -First 1
if ($entry) { $problems.Add('the app is still registered with Windows after uninstalling') }

$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$product.lnk"
if (Test-Path $shortcut) { $problems.Add('the Start menu shortcut is still present after uninstalling') }

if ($problems.Count) {
  "detail=$($problems -join '; ')" >> $env:GITHUB_OUTPUT
  Write-Output "::error title=Uninstall incomplete::$($problems -join '%0A')"
  exit 1
}
"detail=app, registration and shortcut removed" >> $env:GITHUB_OUTPUT
Write-Output 'The uninstaller removed the app, its registration and its shortcut.'
