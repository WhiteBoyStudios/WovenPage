# Check: the display is large enough for the app's working size.
# Hosted Windows runners start at 1024 x 768; the workflow raises it first, and
# this confirms the change took effect before anything depends on it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$detail = "$($bounds.Width) x $($bounds.Height)"
"detail=$detail" >> $env:GITHUB_OUTPUT
Write-Output "Primary display: $detail"

if ($bounds.Width -lt 1920 -or $bounds.Height -lt 1080) {
  Write-Output "::error title=Display too small::The display is $detail; at least 1920 x 1080 is needed so the app opens at its working size."
  exit 1
}
