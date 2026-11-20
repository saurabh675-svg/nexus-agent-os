import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PLATFORM, WORKSPACE } from './config.js';

/**
 * Runtime detection and fast script execution.
 *
 * Bun starts noticeably faster than Node and runs TypeScript directly, so for short-lived scripts
 * (a deck build, a data poke, a check) it is the better executor. It is optional: everything degrades
 * to Node without it, and we never claim a speed-up we have not measured.
 */

let cache = { at: 0, value: null };

function where(exe) {
  const win = PLATFORM.os === 'win32';
  const paths = win
    ? [path.join(process.env.USERPROFILE || '', '.bun', 'bin', exe), `C:\\Program Files\\Bun\\${exe}`, `C:\\Program Files (x86)\\Bun\\${exe}`]
    : ['/usr/local/bin/' + exe, '/usr/bin/' + exe, path.join(process.env.HOME || '', '.bun/bin', exe)];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // fall back to PATH lookup
  const dirs = String(process.env.PATH || '').split(win ? ';' : ':');
  for (const d of dirs) {
    const candidate = path.join(d, win ? `${exe}.exe` : exe);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export function detect({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const bun = where('bun');
  const node = process.execPath;
  cache = {
    at: Date.now(),
    value: {
      bun,
      bunVersion: bun ? bunVersionOf(bun) : null,
      node,
      nodeVersion: process.version,
      prefer: bun ? 'bun' : 'node',
    },
  };
  return cache.value;
}

function bunVersionOf(bunPath) {
  try {
    const r = spawn(bunPath, ['--version'], { windowsHide: true });
    let out = '';
    r.stdout.on('data', (d) => (out += d.toString()));
    return null; // version resolved async in probe(); keep detect() synchronous and cheap
  } catch {
    return null;
  }
}

function exec(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, cwd: opts.cwd || WORKSPACE, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, opts.timeoutMs || 60000);
    child.stdout.on('data', (d) => {
      if (stdout.length < 200000) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 60000) stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, 40000), stderr: stderr.slice(0, 8000) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e.message || e) });
    });
    if (opts.stdin) {
      try {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch {}
    }
  });
}

/** Real measurement, not a claim: start each runtime, print one line, time it. */
export async function bench({ runs = 3 } = {}) {
  const d = detect({ fresh: true });
  const results = {};

  const timeIt = async (label, file, args, stdin) => {
    const times = [];
    let last = null;
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      last = await exec(file, args, { timeoutMs: 20000, stdin });
      times.push(Date.now() - t0);
    }
    results[label] = {
      bestMs: Math.min(...times),
      avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      ok: last?.code === 0,
      stdout: (last?.stdout || '').trim().slice(0, 80),
    };
  };

  await timeIt('node', d.node, ['-e', 'console.log("ok")']);
  if (d.bun) {
    await timeIt('bun', d.bun, ['-e', 'console.log("ok")']);
    const r = await exec(d.bun, ['--version'], { timeoutMs: 10000 });
    results.bunVersion = (r.stdout || '').trim() || null;
  }
  const faster = d.bun && results.bun && results.node ? (results.bun.bestMs < results.node.bestMs ? 'bun' : 'node') : 'node';
  return { detected: d, results, faster, note: d.bun ? null : 'Bun not installed — node is used for scripts' };
}

/** Run a script file (or inline code) with the best available runtime. */
export async function runScript({ file, code, lang, runtime = 'auto', args = [], cwd, timeoutMs = 120000 } = {}) {
  const d = detect();
  let target = file ? path.resolve(cwd || WORKSPACE, file) : null;
  let inline = code || null;
  let kind = runtime;
  const ext = target ? path.extname(target).toLowerCase() : '';

  // Python inline code must go to python. Sending `import pptx` to node/bun fails instantly, which is
  // exactly how a deck build produced no file while the agent reported success.
  const looksPython = lang === 'python' || (inline && /^\s*(import |from \w+ import|def |class |print\()/m.test(inline) && !/=>|const |let |function /.test(inline));
  if (kind === 'python' || (kind === 'auto' && (ext === '.py' || looksPython))) {
    const pyArgs = inline ? ['-c', inline] : [target, ...args.map(String)];
    if (target && !fs.existsSync(target)) throw new Error(`script not found: ${target}`);
    const t0 = Date.now();
    const r = await exec('python', pyArgs, { cwd: cwd || WORKSPACE, timeoutMs });
    return { ok: r.code === 0, runtime: 'python', ms: Date.now() - t0, code: r.code, stdout: r.stdout, stderr: r.stderr, script: target || '(inline python)' };
  }

  if (kind === 'auto') {
    if (['.ts', '.tsx', '.mjs', '.jsx'].includes(ext)) kind = d.bun ? 'bun' : 'node';
    else kind = d.bun ? 'bun' : 'node';
  }
  if (kind === 'bun' && !d.bun) {
    if (['.ts', '.tsx'].includes(ext)) throw new Error('this is TypeScript and Bun is not installed — run: winget install Oven-sh.Bun');
    kind = 'node';
  }
  if (target && !fs.existsSync(target)) throw new Error(`script not found: ${target}`);

  const bin = kind === 'bun' ? d.bun : d.node;
  const argv = inline ? ['-e', inline] : [target, ...args.map(String)];
  const t0 = Date.now();
  const r = await exec(bin, argv, { cwd: cwd || WORKSPACE, timeoutMs, stdin: undefined });
  return {
    ok: r.code === 0,
    runtime: kind,
    ms: Date.now() - t0,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    script: target || '(inline)',
  };
}
