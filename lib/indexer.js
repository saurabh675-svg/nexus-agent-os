import fs from 'node:fs';
import path from 'node:path';
import { DATA, PLATFORM } from './config.js';
import { appendJsonl, readJsonl, ensureDir, truncate, log } from './util.js';

/**
 * PC index — so the agent can answer "where is my deck from Tuesday" without walking the disk again.
 *
 * Deliberately shallow: name, path, size, mtime, extension. Content indexing is expensive and the
 * agent can read any file on demand once it knows the path. Progress is polled by the UI, and the
 * walk yields between directories so it never blocks the server.
 */

const FILE = path.join(DATA, 'index.jsonl');
const STATE = path.join(DATA, 'index-state.json');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)',
  '$Recycle.Bin', 'System Volume Information', 'AppData\\Local\\Temp', 'dist', 'build', '__pycache__',
  '.venv', 'venv', 'site-packages', '.cache', '.conda', 'Temp', 'Cache',
  'include', 'include-fixed', 'headers', 'anaconda3', 'miniconda3', 'msys64', 'mingw64', 'mingw32',
  'Lib', 'Library', 'WinSxS', 'Installer', 'DriverStore', 'assembly', 'Microsoft',
]);

let rows = null;
let scan = { running: false, scanned: 0, startedAt: null, finishedAt: null, roots: [], capped: false, error: null };

function load() {
  if (rows) return rows;
  rows = readJsonl(FILE);
  return rows;
}

export function stats() {
  const all = load();
  const byExt = {};
  let bytes = 0;
  for (const r of all) {
    byExt[r.e] = (byExt[r.e] || 0) + 1;
    bytes += r.s || 0;
  }
  const top = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { files: all.length, bytes, topExt: top, scan, file: FILE };
}

function defaultRoots() {
  const home = PLATFORM.home;
  const roots = [home];
  for (const letter of ['C:', 'D:', 'E:']) {
    if (fs.existsSync(letter + '\\')) roots.push(letter + '\\');
  }
  return [...new Set(roots)];
}

function extOf(name) {
  const e = path.extname(name).toLowerCase();
  return e || '(none)';
}

async function walk(dir, out, max, depth = 0) {
  if (out.length >= max || !scan.running) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max || !scan.running) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (depth > 6) continue;
      await walk(full, out, max, depth + 1);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ p: full, n: e.name, e: extOf(e.name), s: st.size, m: st.mtimeMs });
        scan.scanned = out.length;
      } catch {}
    }
  }
}

/** Starts a scan in the background; returns immediately. */
export function startScan({ roots, max = 120000 } = {}) {
  if (scan.running) return { started: false, scan };
  scan = {
    running: true,
    scanned: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    roots: roots?.length ? roots : defaultRoots(),
    capped: false,
    error: null,
  };
  rows = null;

  (async () => {
    const out = [];
    try {
      for (const root of scan.roots) {
        await walk(root, out, max);
        if (out.length >= max) {
          scan.capped = true;
          break;
        }
      }
      ensureDir(DATA);
      const body = out.map((r) => JSON.stringify(r)).join('\n');
      fs.writeFileSync(FILE, body + (out.length ? '\n' : ''), 'utf8');
      rows = out;
      scan.finishedAt = new Date().toISOString();
      log(`index: ${out.length} files from ${scan.roots.length} root(s)`);
    } catch (e) {
      scan.error = String(e.message || e);
    } finally {
      scan.running = false;
      fs.writeFileSync(STATE, JSON.stringify(scan, null, 2), 'utf8');
    }
  })();

  return { started: true, scan };
}

export function status() {
  return scan;
}

/** Name/path matching with a small relevance boost for extension and recency. */
export function search(query, limit = 60) {
  const all = load();
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return all
      .slice()
      .sort((a, b) => b.m - a.m)
      .slice(0, limit)
      .map(fmt);
  }
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const r of all) {
    const hay = (r.n + ' ' + r.p).toLowerCase();
    let score = 0;
    for (const t of terms) {
      const at = hay.indexOf(t);
      if (at < 0) {
        score = 0;
        break;
      }
      score += t.length + (r.n.toLowerCase().includes(t) ? 6 : 0);
    }
    if (score) scored.push({ r, score: score + Math.min(r.m / 1e13, 1) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => fmt(x.r));
}

function fmt(r) {
  return { name: r.n, path: r.p, ext: r.e, bytes: r.s, at: new Date(r.m).toISOString() };
}

/** Group by folder so "my projects" is meaningful rather than a wall of files. */
export function collections() {
  const all = load();
  const byDir = new Map();
  for (const r of all) {
    const dir = path.dirname(r.p);
    const cur = byDir.get(dir) || { dir, files: 0, bytes: 0, exts: new Map(), last: 0 };
    cur.files++;
    cur.bytes += r.s || 0;
    cur.exts.set(r.e, (cur.exts.get(r.e) || 0) + 1);
    cur.last = Math.max(cur.last, r.m);
    byDir.set(dir, cur);
  }
  const kindOf = (exts) => {
    const top = [...exts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    if (['.py', '.ipynb', '.csv', '.parquet'].includes(top)) return 'data / notebooks';
    if (['.pptx', '.potx', '.docx', '.pdf'].includes(top)) return 'documents / decks';
    if (['.png', '.jpg', '.jpeg', '.tif'].includes(top)) return 'images / maps';
    if (['.js', '.ts', '.json', '.html'].includes(top)) return 'code';
    return 'misc';
  };
  return [...byDir.values()]
    .filter((d) => d.files >= 3)
    .map((d) => ({ dir: d.dir, files: d.files, mb: Math.round((d.bytes / 1e6) * 10) / 10, kind: kindOf(d.exts), last: new Date(d.last).toISOString() }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 80);
}

/** Concrete, actionable suggestions — each one is something the agent can do next. */
export function suggestions({ limit = 8 } = {}) {
  const all = load();
  if (!all.length) return [];
  const out = [];
  const now = Date.now();

  // duplicates: same size + same name in different folders
  const key = new Map();
  for (const r of all) {
    if (r.s < 200 * 1024) continue;
    const k = `${r.n}|${r.s}`;
    key.set(k, [...(key.get(k) || []), r]);
  }
  const dupes = [...key.values()].filter((g) => g.length > 1);
  if (dupes.length) {
    const wasted = dupes.reduce((n, g) => n + g.slice(1).reduce((m, r) => m + r.s, 0), 0);
    out.push({
      id: 'dupes',
      severity: 'medium',
      title: `${dupes.length} duplicate file group(s) — ~${(wasted / 1e9).toFixed(1)} GB`,
      detail: truncate(dupes[0].map((r) => r.p).join('  ·  '), 200),
      action: { tool: 'files', args: { action: 'find', pattern: dupes[0][0].n } },
    });
  }

  // old downloads
  const dl = all.filter((r) => /\\Downloads\\/i.test(r.p) && now - r.m > 90 * 864e5);
  if (dl.length > 5) {
    const gb = dl.reduce((n, r) => n + r.s, 0) / 1e9;
    out.push({ id: 'downloads', severity: 'low', title: `${dl.length} files in Downloads older than 90 days (${gb.toFixed(1)} GB)`, detail: 'Safe to archive or bin.', action: { tool: 'files', args: { action: 'list', path: path.join(PLATFORM.home, 'Downloads') } } });
  }

  // decks
  const decks = all.filter((r) => r.e === '.pptx' || r.e === '.potx');
  if (decks.length) out.push({ id: 'decks', severity: 'info', title: `${decks.length} PowerPoint file(s) indexed`, detail: truncate(decks.slice(0, 3).map((d) => d.n).join(' · '), 160), action: { tool: 'files', args: { action: 'find', pattern: '.pptx' } } });

  // notebooks without outputs / kaggle-ish
  const nbs = all.filter((r) => r.e === '.ipynb');
  if (nbs.length) out.push({ id: 'nbs', severity: 'info', title: `${nbs.length} notebook(s) on disk`, detail: 'Want a baseline run or a push to Kaggle?', action: { tool: 'job', args: { action: 'run', command: 'python kaggle_status.py' } } });

  // biggest files
  const big = all.slice().sort((a, b) => b.s - a.s).slice(0, 5);
  if (big.length) out.push({ id: 'big', severity: 'low', title: `Largest: ${big[0].n} (${(big[0].s / 1e9).toFixed(2)} GB)`, detail: truncate(big.map((b) => `${b.n} ${(b.s / 1e6).toFixed(0)}MB`).join(' · '), 200), action: { tool: 'files', args: { action: 'read', path: big[0].p } } });

  // stale temp/partials
  const junk = all.filter((r) => /\.(tmp|part|crdownload|bak)$/i.test(r.n));
  if (junk.length) out.push({ id: 'junk', severity: 'medium', title: `${junk.length} temp/partial file(s)`, detail: 'Leftovers from interrupted downloads or saves.', action: { tool: 'files', args: { action: 'list', path: path.dirname(junk[0].p) } } });

  return out.slice(0, limit);
}
