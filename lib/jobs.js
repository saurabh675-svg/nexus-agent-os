import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, WORKSPACE } from './config.js';
import { ensureDir, uid, truncate } from './util.js';
import { detect } from './runtime.js';

/**
 * Background job runner.
 *
 * Exists because a synchronous shell call has to die at some timeout, and when it dies the output
 * is lost. Earth Engine exports, Kaggle polling and deck builds run for minutes to hours — they
 * need to outlive the HTTP request that started them, keep their log, and be polled incrementally.
 *
 * Design: in-memory ring buffer per job (bounded), full log written to data/logs/<id>.log on exit,
 * cursor-based reads so the UI can tail without re-sending everything.
 */

const MAX_LINES = 5000;
const MAX_JOBS = 60;
const LOGS = path.join(DATA, 'logs');
const jobs = new Map();

for (const d of [LOGS]) ensureDir(d);

const iso = () => new Date().toISOString();

function summary(j) {
  return {
    id: j.id,
    label: j.label,
    command: j.command,
    cwd: j.cwd,
    kind: j.kind,
    status: j.status,
    code: j.code,
    pid: j.pid,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    lines: j.lines.length,
    bytes: j.bytes,
    percent: j.percent ?? null,
    error: j.error || null,
    logFile: j.logFile || null,
  };
}

function finalize(j) {
  try {
    ensureDir(LOGS);
    j.logFile = path.join(LOGS, `${j.id}.log`);
    const body = j.lines
      .map((l) => `[${new Date(l.t).toISOString().slice(11, 19)}]${l.stream === 'err' ? ' ! ' : '   '}${l.text}`)
      .join('\n');
    fs.writeFileSync(j.logFile, body, 'utf8');
  } catch {}
}

function prune() {
  const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const j of finished.slice(MAX_JOBS)) jobs.delete(j.id);
}

export function run({ command, cwd, label, kind = 'shell', timeoutSec = 0, file, args = [] } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd && !file) throw new Error('job needs a command or a script file');

  const isWin = process.platform === 'win32';
  const workdir = cwd ? path.resolve(WORKSPACE, cwd) : WORKSPACE;
  ensureDir(workdir);

  const id = uid('j_');
  const job = {
    id,
    label: label || truncate(cmd || file, 60),
    command: cmd || `${kind} ${file}`,
    cwd: workdir,
    kind,
    status: 'running',
    code: null,
    pid: null,
    startedAt: iso(),
    endedAt: null,
    lines: [],
    bytes: 0,
    percent: null,
    child: null,
  };
  jobs.set(id, job);

  const child = ['bun', 'node'].includes(kind)
    ? (() => {
        const d = detect();
        const bin = kind === 'bun' ? d.bun || process.execPath : process.execPath;
        return spawn(bin, file ? [path.resolve(workdir, file), ...args.map(String)] : ['-e', cmd], {
          cwd: workdir,
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
      })()
    : isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
          cwd: workdir,
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        })
      : spawn('bash', ['-lc', cmd], { cwd: workdir, env: { ...process.env, PYTHONUNBUFFERED: '1' } });

  job.child = child;
  job.pid = child.pid;

  const push = (stream, buf) => {
    const text = buf.toString('utf8');
    job.bytes += text.length;
    // Progress: prefer an explicit NN% in the output, else a 3/11 style fraction.
    const pcts = [...text.matchAll(/(\d{1,3})\s?%/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
    if (pcts.length) job.percent = pcts[pcts.length - 1];
    else {
      const frac = text.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
      if (frac) {
        const done = Number(frac[1]);
        const total = Number(frac[2]);
        if (total > 0 && total <= 500 && done <= total) job.percent = Math.round((done / total) * 100);
      }
    }
    // keep partial lines readable: split on newlines, keep the remainder attached to the next chunk
    const parts = text.split(/\r?\n/);
    for (const part of parts) {
      if (part === '' && parts.length === 1) continue;
      job.lines.push({ t: Date.now(), stream, text: part });
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  };

  child.stdout.on('data', (d) => push('out', d));
  child.stderr.on('data', (d) => push('err', d));
  child.on('close', (code) => {
    if (job.status === 'killed') {
      job.endedAt = job.endedAt || iso();
      return;
    }
    job.status = code === 0 ? 'done' : 'error';
    job.code = code;
    job.endedAt = iso();
    finalize(job);
    prune();
  });
  child.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.endedAt = iso();
    finalize(job);
    prune();
  });

  if (timeoutSec > 0) {
    setTimeout(() => {
      if (job.status === 'running') kill(id);
    }, Math.min(timeoutSec, 6 * 3600) * 1000).unref?.();
  }

  return summary(job);
}

export function list() {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summary);
}

export function get(id, since = 0) {
  const j = jobs.get(id);
  if (!j) throw new Error(`no such job: ${id}`);
  const from = Math.max(0, Number(since) || 0);
  return {
    ...summary(j),
    next: j.lines.length,
    lines: j.lines.slice(from),
  };
}

export function kill(id) {
  const j = jobs.get(id);
  if (!j) throw new Error(`no such job: ${id}`);
  if (j.status !== 'running') return { ...summary(j), killed: false, note: 'already finished' };
  try {
    if (process.platform === 'win32' && j.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(j.pid)], { windowsHide: true });
    } else {
      j.child?.kill('SIGKILL');
    }
    j.status = 'killed';
    j.endedAt = iso();
    finalize(j);
    return { ...summary(j), killed: true };
  } catch (e) {
    throw new Error(`could not kill job: ${e.message}`);
  }
}

/** Tail for the agent — plain text, not JSON, so it fits in a prompt cheaply. */
export function tail(id, lines = 60) {
  const j = jobs.get(id);
  if (!j) throw new Error(`no such job: ${id}`);
  const slice = j.lines.slice(-Math.min(lines, 400));
  return {
    ...summary(j),
    text: truncate(slice.map((l) => `${l.stream === 'err' ? '! ' : ''}${l.text}`).join('\n'), 6000),
    stillRunning: j.status === 'running',
  };
}

export function runningCount() {
  return [...jobs.values()].filter((j) => j.status === 'running').length;
}
