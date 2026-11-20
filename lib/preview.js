import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DATA, ROOT, WORKSPACE } from './config.js';
import { ensureDir, truncate } from './util.js';

/**
 * Preview + artifact verification.
 *
 * The rule this enforces: a file is only "done" when it exists on disk with a size, and a claim like
 * "saved to your workspace" must resolve to a real path. The agent cannot assert success any more.
 */

export const PROJECT = path.dirname(ROOT);
const THUMBS = path.join(DATA, 'thumbs');
const PREVIEWS = path.join(DATA, 'previews');

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const OFFICE = new Set(['.pptx', '.potx', '.docx', '.xlsx', '.pdf']);
const TEXT = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.css',
  '.py', '.js', '.mjs', '.ts', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.sh', '.ps1', '.sql', '.log', '.ipynb',
]);

function run(cmd, args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE.has(ext)) return 'image';
  if (OFFICE.has(ext)) return 'office';
  if (TEXT.has(ext)) return 'text';
  return 'binary';
}

export function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { path: file, name: path.basename(file), exists: true, bytes: st.size, at: st.mtime.toISOString(), kind: kindOf(file) };
  } catch {
    return { path: file, name: path.basename(file), exists: false, bytes: 0, at: null, kind: kindOf(file) };
  }
}

/** Anything the run touched, inside the visible workspace or the project folder. */
export function recentArtifacts({ minutes = 20, limit = 25 } = {}) {
  const since = Date.now() - minutes * 60000;
  const out = [];
  for (const root of [WORKSPACE, PROJECT]) {
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          try {
            const st = fs.statSync(full);
            if (st.mtimeMs >= since) out.push({ ...statOf(full), at: st.mtime.toISOString() });
          } catch {}
        }
      }
    };
    walk(root, 0);
  }
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, limit);
}

/** Pull plausible file paths out of the model's prose. */
export function claimedPaths(text) {
  const s = String(text || '');
  const found = new Set();
  // Paths nearly always end in an extension. Matching up to the extension keeps "a.pptx and also
  // b.pptx" as two paths instead of one greedy string with prose inside it.
  for (const m of s.matchAll(/[A-Za-z]:\\[^\n\r"'<>|?*]*?\.[A-Za-z0-9]{1,6}\b/g)) {
    const clean = m[0].trim().replace(/[).,;:]+$/, '');
    if (clean.length > 6) found.add(clean);
  }
  // Extension-less paths (folders): only accept a token with no spaces, so prose is never captured.
  for (const m of s.matchAll(/[A-Za-z]:\\[^\s"'<>|?*]+/g)) {
    const clean = m[0].trim().replace(/[).,;:]+$/, '');
    if (clean.length > 6 && !found.has(clean)) found.add(clean);
  }
  return [...found].slice(0, 12);
}

export function verifyClaims(text) {
  const claimed = claimedPaths(text);
  const checked = claimed.map((p) => statOf(p));
  return { claimed: checked, missing: checked.filter((c) => !c.exists) };
}

/* ------------------------------- thumbnails ------------------------------- */

function cacheKey(file) {
  try {
    const st = fs.statSync(file);
    return crypto.createHash('sha1').update(`${file}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(String(file)).digest('hex').slice(0, 16);
  }
}

/** PowerPoint COM export → real slide images. Falls back to nothing if PowerPoint is unavailable. */
export async function slideThumbs(file, { force = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!['.pptx', '.potx', '.ppt'].includes(ext)) return { ok: false, reason: 'not a presentation' };
  ensureDir(THUMBS);
  const key = cacheKey(file);
  const dir = path.join(THUMBS, key);
  const marker = path.join(dir, '.done');
  if (!force && fs.existsSync(marker)) {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort(naturalSort);
    if (files.length) return { ok: true, key, count: files.length, urls: files.map((f) => `/api/thumb?key=${key}&file=${encodeURIComponent(f)}`) };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const ps1 = path.join(ROOT, 'scripts', 'thumbs.ps1');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-In', file, '-Out', dir], 180000);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort(naturalSort) : [];
  if (!files.length) return { ok: false, reason: truncate(r.stderr || r.error || 'no slides exported', 300) };
  fs.writeFileSync(marker, files.length + '\n');
  return { ok: true, key, count: files.length, urls: files.map((f) => `/api/thumb?key=${key}&file=${encodeURIComponent(f)}`) };
}

function naturalSort(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/* -------------------------------- preview -------------------------------- */

export async function preview(file, { thumbs = true } = {}) {
  const st = statOf(file);
  if (!st.exists) return { ok: false, ...st, error: 'file does not exist' };
  if (st.bytes > 80 * 1024 * 1024) return { ok: false, ...st, error: 'file too large to preview' };

  const ext = path.extname(file).toLowerCase();
  const base = { ok: true, ...st, ext };

  if (IMAGE.has(ext)) return { ...base, kind: 'image', url: '/api/artifact?path=' + encodeURIComponent(file) };

  if (TEXT.has(ext)) {
    const raw = fs.readFileSync(file, 'utf8');
    return { ...base, kind: 'text', text: truncate(raw, 40000), lines: raw.split('\n').length };
  }

  if (['.pptx', '.potx', '.ppt'].includes(ext)) {
    const py = await run('python', [path.join(ROOT, 'scripts', 'extract.py'), file], 60000);
    let meta = {};
    let text = '';
    try {
      const parsed = JSON.parse(py.stdout.trim().split('\n').pop());
      text = parsed.text || '';
      meta = { slides: parsed.slides, notes: parsed.notes, error: parsed.error };
    } catch {}
    const th = thumbs ? await slideThumbs(file) : { ok: false };
    return { ...base, kind: 'pptx', text: truncate(text, 40000), meta, thumbs: th.ok ? th.urls : [], thumbsError: th.ok ? null : th.reason };
  }

  if (['.docx', '.xlsx', '.pdf'].includes(ext)) {
    const py = await run('python', [path.join(ROOT, 'scripts', 'extract.py'), file], 60000);
    let parsed = {};
    try {
      parsed = JSON.parse(py.stdout.trim().split('\n').pop());
    } catch {}
    return { ...base, kind: ext.slice(1), text: truncate(parsed.text || '', 40000), meta: { error: parsed.error, ...parsed }, chars: (parsed.text || '').length };
  }

  return { ...base, kind: 'binary', note: 'no preview for this type — use "open with Windows"' };
}
