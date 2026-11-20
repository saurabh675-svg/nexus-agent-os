/**
 * Desktop CUA starter (7.1) — gated OS input via platform tools (zero npm deps).
 * Windows: PowerShell mouse/keyboard. Linux: xdotool if present. macOS: cliclick/osascript.
 * Always pass through policy.gate — treat as high-risk exec.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORM, DATA } from './config.js';
import { ensureDir, truncate } from './util.js';
import * as browser from './browser.js';

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    if (input) child.stdin?.end(input);
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ code: -1, out, err: err || 'timeout' });
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 0, out, err });
    });
  });
}

export async function screenshotDesktop() {
  ensureDir(path.join(DATA, 'shots'));
  const file = path.join(DATA, 'shots', `desk-${Date.now()}.png`);
  const os = PLATFORM.os;

  if (os === 'win32') {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${file.replace(/'/g, "''")}')
$g.Dispose(); $bmp.Dispose()
Write-Output "$($b.Width)x$($b.Height)"
`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps]);
    if (!fs.existsSync(file)) throw new Error('desktop screenshot failed: ' + (r.err || r.out));
    return { ok: true, file: path.basename(file), path: file, size: r.out.trim() };
  }

  if (os === 'darwin') {
    const r = await run('screencapture', ['-x', file]);
    if (!fs.existsSync(file)) throw new Error('screencapture failed: ' + (r.err || r.out));
    return { ok: true, file: path.basename(file), path: file };
  }

  // Linux
  for (const [cmd, args] of [
    ['gnome-screenshot', ['-f', file]],
    ['import', ['-window', 'root', file]],
    ['scrot', [file]],
  ]) {
    const r = await run(cmd, args);
    if (fs.existsSync(file)) return { ok: true, file: path.basename(file), path: file };
  }
  throw new Error('No screenshot tool found (gnome-screenshot, import, or scrot)');
}

export async function clickAt(x, y, { button = 'left', double = false } = {}) {
  const os = PLATFORM.os;
  x = Math.round(Number(x));
  y = Math.round(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('clickAt needs numeric x,y');

  if (os === 'win32') {
    const clicks = double ? 2 : 1;
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 40
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
for ($i=0; $i -lt ${clicks}; $i++) {
  [M]::mouse_event(0x0002, 0, 0, 0, 0)
  [M]::mouse_event(0x0004, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 50
}
Write-Output "clicked ${x},${y}"
`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps]);
    return { ok: r.code === 0, x, y, detail: truncate(r.out || r.err, 200) };
  }

  if (os === 'darwin') {
    const r = await run('osascript', [
      '-e',
      `tell application "System Events" to click at {${x}, ${y}}`,
    ]);
    return { ok: r.code === 0, x, y, detail: truncate(r.out || r.err, 200) };
  }

  const r = await run('xdotool', ['mousemove', String(x), String(y), 'click', double ? '2' : '1']);
  return { ok: r.code === 0, x, y, detail: truncate(r.out || r.err, 200) };
}

export async function typeText(text) {
  text = String(text ?? '');
  const os = PLATFORM.os;
  if (os === 'win32') {
    // Use SendKeys carefully — escape special chars
    const esc = text.replace(/[+^%~(){}]/g, '{$&}').replace(/"/g, '""');
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${esc.slice(0, 500)}")
`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps]);
    return { ok: r.code === 0, typed: text.slice(0, 100) };
  }
  if (os === 'darwin') {
    const r = await run('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text.slice(0, 200))}`]);
    return { ok: r.code === 0, typed: text.slice(0, 100) };
  }
  const r = await run('xdotool', ['type', '--', text.slice(0, 500)]);
  return { ok: r.code === 0, typed: text.slice(0, 100) };
}

export async function hotkey(keys) {
  // keys like "ctrl+c" or "alt+tab"
  const parts = String(keys).toLowerCase().split('+').map((s) => s.trim());
  const os = PLATFORM.os;
  if (os === 'win32') {
    const map = { ctrl: '^', alt: '%', shift: '+', win: '^{ESC}' };
    let seq = '';
    const mods = parts.slice(0, -1).map((p) => map[p] || '').join('');
    const key = parts[parts.length - 1] || '';
    seq = mods + key;
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${seq}")`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps]);
    return { ok: r.code === 0, keys };
  }
  if (os === 'linux') {
    const r = await run('xdotool', ['key', parts.join('+')]);
    return { ok: r.code === 0, keys };
  }
  return { ok: false, error: 'hotkey not implemented for this OS yet', keys };
}

/**
 * Vision fallback: if browser click by ref fails, screenshot + ask vision for coordinates.
 * Requires vision module when available.
 */
export async function clickWithVisionFallback({ ref, index, text, target, model }) {
  try {
    const r = await browser.click({ ref, index, text });
    if (r && r !== 'missing') return { ok: true, method: 'ref', result: r };
  } catch {}
  // escalate
  try {
    const vision = await import('./vision.js');
    if (vision.clickByVision) {
      const r = await vision.clickByVision({ target: target || text || ref, model });
      return { ok: true, method: 'vision', result: r };
    }
  } catch (e) {
    return { ok: false, error: 'ref click failed and vision unavailable: ' + (e.message || e) };
  }
  return { ok: false, error: 'ref click missed; vision fallback not available' };
}
