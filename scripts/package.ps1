param(
  [string]$Version = '1.0.0',
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist "nexus-$Version"

Write-Host "Packaging Nexus $Version" -ForegroundColor Cyan
Write-Host "  from: $root"

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Program files only. User data (data\), secrets and the Chrome profile are deliberately excluded.
$include = @(
  'server.js',
  'package.json',
  'package-lock.json',
  'start.cmd',
  'install.cmd',
  'README.md',
  'START-HERE.md',
  'INSTALL.md',
  'lib',
  'public',
  'skills',
  'docs',
  'scripts',
  'desktop',
  'agents'
)

foreach ($item in $include) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { Write-Host "  [skip] $item (missing)" -ForegroundColor DarkYellow; continue }
  Copy-Item $src -Destination $stage -Recurse -Force
  Write-Host "  [ok]   $item"
}

# Clean artifacts that should never ship.
$junk = @(
  'scripts\probe-keys.mjs',
  'scripts\probe-press.mjs',
  'scripts\probe-approval-tmp.mjs'
)
foreach ($j in $junk) {
  $p = Join-Path $stage $j
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "  [rm]   $j" }
}

# Fresh, empty data folder so the app initialises itself on first run.
New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null
Set-Content -Path (Join-Path $stage 'data\.gitkeep') -Value 'Nexus creates its state here on first run.' -Encoding utf8
New-Item -ItemType Directory -Path (Join-Path $stage 'data\workspace') -Force | Out-Null

# Refuse to ship anything that looks like a secret or personal state.
$forbidden = @('settings.json', 'vault.json', 'brain.jsonl', 'brain-sync.json', 'audit.jsonl', 'tasks.json', 'kaggle.json')
$leaks = Get-ChildItem $stage -Recurse -File | Where-Object { $forbidden -contains $_.Name }
if ($leaks) {
  Write-Host "`nREFUSING TO PACKAGE - these must not leave your machine:" -ForegroundColor Red
  $leaks | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
  exit 1
}
if (Test-Path (Join-Path $stage 'data\chrome-profile')) {
  Write-Host "REFUSING TO PACKAGE - chrome profile included" -ForegroundColor Red
  exit 1
}

$files = Get-ChildItem $stage -Recurse -File
$sizeMb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 2)
Write-Host "`n  staged: $($files.Count) files, $sizeMb MB" -ForegroundColor Green

if ($SkipZip) { Write-Host "  (-SkipZip: no archive written)"; exit 0 }

$zip = Join-Path $dist "nexus-$Version.zip"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$names = $archive.Entries | ForEach-Object { $_.FullName }
$archive.Dispose()

$bad = $names | Where-Object { $n = $_; $forbidden | Where-Object { $n -like "*$_" } }
if ($bad) {
  Write-Host "REFUSING - archive contains secrets:" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 1
}

$zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "`n  archive: $zip" -ForegroundColor Green
Write-Host "  size:    $zipMb MB - $($names.Count) entries"
Write-Host "  root:    nexus-$Version (folder)"
Write-Host ""
Write-Host "  Next: unzip on the target PC, run install.cmd." -ForegroundColor Cyan
