param([string]$TargetRoot)
$ErrorActionPreference = 'Stop'
function Get-Checksum([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
try {
  if (-not $TargetRoot) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Select your WORKING ORIGINAL Nexus 7.1 folder containing server.js'
    if ($picker.ShowDialog() -ne 'OK') { Write-Host 'No changes made.'; exit 0 }
    $TargetRoot = $picker.SelectedPath
    $picker.Dispose()
  }
  $target = (Resolve-Path -LiteralPath $TargetRoot).Path.TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $target 'server.js') -PathType Leaf)) { throw 'Select the original Nexus 7.1 folder containing server.js.' }
  $pkg = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.name -ne 'nexus-agent-os' -or $pkg.version -ne '7.1.0') { throw 'This update requires the ORIGINAL nexus-agent-os version 7.1.0. No files were changed.' }
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
  $allowed = @('public/app.js','public/index.html','public/workspace.css','public/workspace-runtime.js','start.cmd','Start Nexus.cmd','scripts/start-enhanced.ps1','lib/llm.js','lib/config.js','lib/agentloop.js','server.js')
  if ($manifest.files.Count -ne $allowed.Count) { throw 'The update package is incomplete.' }
  foreach ($entry in $manifest.files) {
    if ($allowed -notcontains $entry.path) { throw 'Unexpected update file.' }
    $source = Join-Path (Join-Path $PSScriptRoot 'payload') $entry.path
    if ((Get-Checksum $source) -ne $entry.sha256) { throw "Update checksum failed: $($entry.path)" }
    $dest = [IO.Path]::GetFullPath((Join-Path $target $entry.path))
    if (-not $dest.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update destination.' }
    $inspect = $dest
    while ($inspect -and $inspect.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) {
      if (Test-Path -LiteralPath $inspect) {
        $item = Get-Item -LiteralPath $inspect -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked folders or files are not supported by this updater.' }
      }
      if ($inspect -eq $target) { break }
      $inspect = Split-Path -Parent $inspect
    }
  }
  $allCurrent = $true
  foreach ($entry in $manifest.files) {
    $dest = Join-Path $target $entry.path
    if (Test-Path -LiteralPath $dest -PathType Leaf) {
      $actual = Get-Checksum $dest
      if ($entry.allowedHashes -notcontains $actual) { throw ("Customized file differs: " + $entry.path + ". No changes applied.") }
      if ($actual -ne $entry.sha256) { $allCurrent = $false }
    } else { $allCurrent = $false }
  }
  if ($allCurrent) { Write-Host 'This refinement is already installed. Restart Nexus.'; exit 0 }
  $backup = Join-Path $target ('.nexus-upgrade-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  $before = @{}
  foreach ($entry in $manifest.files) {
    $dest = Join-Path $target $entry.path
    $before[$entry.path] = Test-Path -LiteralPath $dest -PathType Leaf
    if ($before[$entry.path]) {
      $saved = Join-Path $backup $entry.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
      Copy-Item -LiteralPath $dest -Destination $saved
    }
  }
  try {
    foreach ($entry in $manifest.files) {
      $dest = Join-Path $target $entry.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'payload') $entry.path) -Destination $dest -Force
      if ((Get-Checksum $dest) -ne $entry.sha256) { throw "Readback failed: $($entry.path)" }
    }
  } catch {
    foreach ($entry in $manifest.files) {
      $dest = Join-Path $target $entry.path
      if ($before[$entry.path]) { Copy-Item -LiteralPath (Join-Path $backup $entry.path) -Destination $dest -Force }
      elseif (Test-Path -LiteralPath $dest -PathType Leaf) { Remove-Item -LiteralPath $dest -Force }
    }
    throw
  }
  Write-Host 'Upgrade applied. Close the old Nexus startup window, then run Start Nexus.cmd in your original folder. Your settings and data were preserved.'
  Write-Host "Backup: $backup"
} catch { Write-Host ('Update stopped: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
