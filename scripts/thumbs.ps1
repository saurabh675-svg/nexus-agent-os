param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$app = $null
$pres = $null
try {
  if (-not (Test-Path $In)) { throw "input not found: $In" }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null

  $app = New-Object -ComObject PowerPoint.Application
  # WithWindow = $false keeps it invisible; some builds refuse, so fall back with a window.
  try { $pres = $app.Presentations.Open($In, $true, $false, $false) }
  catch { $pres = $app.Presentations.Open($In, $true, $false, $true) }

  $pres.Export($Out, 'PNG', 1280, 720)
  $count = (Get-ChildItem $Out -Filter *.png -ErrorAction SilentlyContinue | Measure-Object).Count
  Write-Output "exported=$count"
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($pres) { try { $pres.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) 2>$null | Out-Null
}
