param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$candidates = @()
$found = Get-Command node.exe -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
$candidates += (Join-Path $appRoot 'runtime\node.exe')
if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe') }
$runtime = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    $version = (& $candidate --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { $runtime = $candidate; break }
  } catch {}
}
if (-not $runtime) { throw 'Node.js 20 or newer was not found. Install the current Node.js LTS, then open start.cmd again.' }
if ($CheckOnly) { Write-Host "Ready: Node.js $version"; exit 0 }
Set-Location -LiteralPath $appRoot
$port = 8787
if ($env:PORT) {
  $parsed = 0
  if (-not [int]::TryParse($env:PORT, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) { throw 'PORT must be a number from 1 to 65535.' }
  $port = $parsed
}
$address = "http://127.0.0.1:$port"
try {
  $page = Invoke-WebRequest -UseBasicParsing -Uri $address -TimeoutSec 2
  if ($page.StatusCode -eq 200 -and $page.Content.Contains('/os7.css') -and $page.Content.Contains('Nexus')) {
    Write-Host 'Nexus is already running. Opening the existing window.'
    Start-Process $address
    exit 0
  }
} catch {}
$probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
try { $probe.Start() }
catch { throw "Port $port is unavailable. Close the other application using it, then open Start Nexus again." }
finally { $probe.Stop() }
Write-Host 'Starting the original Nexus 7.1 with its enhanced workspace.'
Write-Host 'Keep this window open while using Nexus. Press Ctrl+C here to stop.'
& $runtime (Join-Path $appRoot 'server.js')
exit $LASTEXITCODE
