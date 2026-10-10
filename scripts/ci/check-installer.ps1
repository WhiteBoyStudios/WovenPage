# Check: the installer works as designed.
# Runs the real installer silently, then confirms it did what an installer is
# meant to do: put the app in place, register it with Windows so it can be
# uninstalled, and add a Start menu shortcut that points at it.

param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
$package = Get-Content package.json -Raw | ConvertFrom-Json
$product = $package.productName
$version = $package.version
$problems = New-Object System.Collections.Generic.List[string]

$installer = Join-Path 'release' "$product-Setup-$version.exe"
if (-not (Test-Path $installer)) {
  Write-Output "::error title=Installer missing::$installer does not exist; the packaging step did not produce it."
  exit 1
}

Write-Output "Installing $installer silently into $InstallDir"
# /S = silent. /D sets the folder; it must be the last argument and unquoted.
$process = Start-Process -FilePath (Resolve-Path $installer) -ArgumentList '/S', "/D=$InstallDir" -PassThru -Wait
if ($process.ExitCode -ne 0) { $problems.Add("the installer exited with code $($process.ExitCode)") }

# The registry entry is how Windows (Settings > Apps) knows the app is installed.
$entry = $null
for ($i = 0; $i -lt 60 -and -not $entry; $i++) {
  $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "$product*" } | Select-Object -First 1
  if (-not $entry) { Start-Sleep -Seconds 2 }
}

$dir = $InstallDir
if (-not $entry) {
  $problems.Add('no uninstall entry was registered with Windows')
} else {
  Write-Output "Registered as '$($entry.DisplayName)' version $($entry.DisplayVersion)"
  if ($entry.DisplayVersion -ne $version) { $problems.Add("registered version is $($entry.DisplayVersion), expected $version") }
  if (-not $entry.UninstallString) { $problems.Add('the uninstall entry has no uninstall command') }
  if ($entry.InstallLocation -and (Test-Path $entry.InstallLocation)) { $dir = $entry.InstallLocation.TrimEnd('\') }
}
if ($dir -ne $InstallDir) { Write-Output "Note: installed to $dir rather than the requested $InstallDir" }

$exe = Join-Path $dir "$product.exe"
for ($i = 0; $i -lt 30 -and -not (Test-Path $exe); $i++) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $exe)) {
  $problems.Add("$product.exe was not installed in $dir")
} else {
  $info = (Get-Item $exe).VersionInfo
  Write-Output "Installed $exe (product '$($info.ProductName)', file version $($info.FileVersion))"
  if ($info.ProductName -ne $product) { $problems.Add("the executable's product name is '$($info.ProductName)', expected '$product'") }
  if (-not "$($info.FileVersion)".StartsWith($version)) { $problems.Add("the executable's version is $($info.FileVersion), expected $version") }
}
if (-not (Test-Path (Join-Path $dir 'resources\app.asar'))) { $problems.Add('resources\app.asar was not installed') }
$uninstaller = Join-Path $dir "Uninstall $product.exe"
if (-not (Test-Path $uninstaller)) { $problems.Add("'Uninstall $product.exe' was not installed") }

$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$product.lnk"
if (-not (Test-Path $shortcut)) {
  $problems.Add('no Start menu shortcut was created')
} else {
  $target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
  if ($target -ne $exe) { $problems.Add("the Start menu shortcut points at '$target', expected '$exe'") }
}

"install_dir=$dir" >> $env:GITHUB_OUTPUT
"exe=$exe" >> $env:GITHUB_OUTPUT
if ($problems.Count) {
  "detail=$($problems -join '; ')" >> $env:GITHUB_OUTPUT
  Write-Output "::error title=Installer did not behave as designed::$($problems -join '%0A')"
  exit 1
}
"detail=installed, registered with Windows, Start menu shortcut and uninstaller in place" >> $env:GITHUB_OUTPUT
Write-Output 'The installer behaved as designed.'
