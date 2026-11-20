import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PLATFORM } from './config.js';
import { fetchWithTimeout, truncate } from './util.js';

/**
 * Bring the apps already installed on this PC into the workspace.
 *
 * Two read-only inventories:
 *  - Start Menu shortcuts (readable, launchable, no guessing of install paths)
 *  - the Uninstall registry keys (name, version, size) so a "what is eating my disk" question has data
 *
 * Deliberately NOT implemented: uninstalling. Silent uninstall via UninstallString is the fastest way to
 * break a Windows install — many of those strings are interactive, some reboot, some are wrong. The UI
 * opens Windows' own uninstaller instead, and the human clicks.
 */

let cache = { at: 0, apps: null };

function ps(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

const START_MENUS = () => [
  path.join(process.env.APPDATA || path.join(PLATFORM.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
];

/** Start Menu shortcuts → launchable apps. Cached for five minutes; the folder rarely changes. */
export async function listApps({ fresh = false } = {}) {
  if (!fresh && cache.apps && Date.now() - cache.at < 300000) return cache.apps;
  const dirs = START_MENUS().filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
  if (!dirs.length) return [];

  const quoted = dirs.map((d) => `'${d.replace(/'/g, "''")}'`).join(',');
  const script = `
$sh = New-Object -ComObject WScript.Shell
$out = @()
foreach ($d in @(${quoted})) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $sh.CreateShortcut($_.FullName)
      $out += [pscustomobject]@{ name = $_.BaseName; lnk = $_.FullName; target = $s.TargetPath; args = $s.Arguments }
    } catch {}
  }
}
$out | ConvertTo-Json -Compress -Depth 3
`;

  const r = await ps(script, 90000);
  let rows = [];
  try {
    rows = JSON.parse(r.stdout.trim() || '[]');
    if (!Array.isArray(rows)) rows = [rows];
  } catch {
    rows = [];
  }

  const seen = new Set();
  const apps = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const target = String(row.target || '');
    // Skip uninstallers/documentation shortcuts: they are not apps you launch daily.
    if (/uninstall|readme|help|website|documentation|release notes/i.test(name)) continue;
    if (!/\.(exe|bat|cmd|msc|appref-ms)$/i.test(target) && !/\.(exe|bat|cmd)$/i.test(String(row.lnk || ''))) {
      if (!target) continue;
    }
    seen.add(key);
    apps.push({ name, lnk: row.lnk, target, args: String(row.args || '').slice(0, 200) });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), apps };
  return apps;
}

/** Launch by shortcut path, resolved target, or app name. */
export async function launch({ name, lnk, target } = {}) {
  let command = '';
  if (lnk && fs.existsSync(lnk)) command = `Start-Process -FilePath '${String(lnk).replace(/'/g, "''")}'`;
  else if (target && fs.existsSync(target)) command = `Start-Process -FilePath '${String(target).replace(/'/g, "''")}'`;
  else if (name) {
    const app = (await listApps()).find((a) => a.name.toLowerCase() === String(name).toLowerCase());
    if (!app) throw new Error(`no Start Menu app named "${name}"`);
    command = app.lnk ? `Start-Process -FilePath '${app.lnk.replace(/'/g, "''")}'` : `Start-Process -FilePath '${String(app.target).replace(/'/g, "''")}'`;
  } else throw new Error('launch needs a name, lnk or target');

  const r = await ps(command + ' ; "launched"', 30000);
  return { ok: r.ok, output: truncate(r.stdout.trim(), 200), error: r.ok ? null : truncate(r.stderr, 300) };
}

/** Installed programs with sizes — the honest "what is on this PC" list, read-only. */
export async function installedPrograms() {
  const script = `
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName }
$items | ForEach-Object {
  [pscustomobject]@{
    name = $_.DisplayName
    version = $_.DisplayVersion
    publisher = $_.Publisher
    kb = if ($_.EstimatedSize) { [int]$_.EstimatedSize } else { 0 }
    installed = $_.InstallDate
    uninstall = $_.UninstallString
    location = $_.InstallLocation
  }
} | Sort-Object kb -Descending | ConvertTo-Json -Compress -Depth 3
`;
  const r = await ps(script, 90000);
  let rows = [];
  try {
    rows = JSON.parse(r.stdout.trim() || '[]');
    if (!Array.isArray(rows)) rows = [rows];
  } catch {}
  return rows
    .filter((x) => x && x.name)
    .map((x) => ({
      name: String(x.name).slice(0, 120),
      version: String(x.version || ''),
      publisher: String(x.publisher || ''),
      mb: Math.round((Number(x.kb) || 0) / 1024 * 10) / 10,
      installed: String(x.installed || ''),
      location: String(x.location || ''),
      hasUninstaller: Boolean(x.uninstall),
    }));
}

/** Open Windows' own Apps list so the human does the removal. */
export async function openUninstaller({ name } = {}) {
  const r = await ps(`Start-Process 'ms-settings:appsfeatures' ; "opened"`, 20000);
  return {
    ok: r.ok,
    opened: 'Settings → Apps → Installed apps',
    note: name ? `Find "${name}" there and choose Uninstall.` : 'Pick what to remove yourself — no silent uninstalls from here.',
  };
}

/** Disk pressure: free space per drive, so "my PC is full" becomes a number. */
export async function disks() {
  const script = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { [pscustomobject]@{ name=$_.Name; usedGB=[math]::Round($_.Used/1GB,1); freeGB=[math]::Round($_.Free/1GB,1); totalGB=[math]::Round(($_.Used+$_.Free)/1GB,1) } } | ConvertTo-Json -Compress`;
  const r = await ps(script, 30000);
  try {
    const rows = JSON.parse(r.stdout.trim() || '[]');
    return Array.isArray(rows) ? rows : [rows];
  } catch {
    return [];
  }
}
