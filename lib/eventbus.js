/**
 * Omniscient Semantic Event Bus (Phase 2)
 * Low-overhead ring buffer of semantic events from Terminal, Browser, Files, Jobs, Scheduler.
 * Action Center reads recent intent cards from here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, uid } from './util.js';

const DIR = path.join(DATA, 'events');
ensureDir(DIR);
const LOG = path.join(DIR, 'bus.jsonl');
const MAX_MEMORY = 200;
const MAX_FILE_LINES = 2000;

const memory = [];
const listeners = new Set();

function persist(ev) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
  } catch {}
}

export function emit(type, payload = {}, { severity = 'info', source = 'system' } = {}) {
  const ev = {
    id: uid(),
    ts: Date.now(),
    type: String(type || 'event'),
    severity, // info | warn | error | intent
    source,
    payload: payload || {},
  };
  memory.push(ev);
  if (memory.length > MAX_MEMORY) memory.shift();
  persist(ev);
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {}
  }
  return ev;
}

export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recent({ limit = 40, type, severity, since } = {}) {
  let list = memory.slice();
  if (!list.length) {
    // hydrate from disk once
    try {
      const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines.slice(-MAX_MEMORY)) {
        try {
          memory.push(JSON.parse(line));
        } catch {}
      }
      list = memory.slice();
    } catch {}
  }
  if (type) list = list.filter((e) => e.type === type);
  if (severity) list = list.filter((e) => e.severity === severity);
  if (since) list = list.filter((e) => e.ts >= since);
  return list.slice(-limit).reverse();
}

/** Turn raw events into proactive Intent Cards for Action Center */
export function intentCards({ limit = 12 } = {}) {
  const cards = [];
  const seen = new Set();
  for (const ev of recent({ limit: 80 })) {
    let card = null;
    if (ev.type === 'terminal.error' || (ev.type === 'shell.exit' && ev.payload?.code && ev.payload.code !== 0)) {
      const err = String(ev.payload?.stderr || ev.payload?.error || '').slice(0, 300);
      const key = 'term:' + err.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      // detect common Python missing module
      const mod = err.match(/ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i);
      if (mod) {
        card = {
          id: ev.id,
          title: `Missing Python module: ${mod[1]}`,
          body: `Detected in terminal. Click to install in a venv-friendly way.`,
          severity: 'error',
          actions: [
            { label: 'Install', prompt: `Install the Python package "${mod[1]}" into the current workspace virtualenv if one exists, otherwise with pip --user. Then retry the last failing command if safe.` },
            { label: 'Inspect log', prompt: `Show me the last terminal error involving ${mod[1]} and explain the fix.` },
          ],
          ts: ev.ts,
        };
      } else {
        card = {
          id: ev.id,
          title: 'Terminal command failed',
          body: err.slice(0, 160) || `exit code ${ev.payload?.code}`,
          severity: 'error',
          actions: [{ label: 'Diagnose', prompt: `A terminal command failed with: ${err.slice(0, 200)}. Diagnose and propose the smallest fix.` }],
          ts: ev.ts,
        };
      }
    } else if (ev.type === 'browser.error' || ev.type === 'browser.console.error') {
      const msg = String(ev.payload?.message || '').slice(0, 200);
      const key = 'br:' + msg.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      card = {
        id: ev.id,
        title: 'Browser issue',
        body: msg || 'Console / navigation error',
        severity: 'warn',
        actions: [{ label: 'Investigate', prompt: `Browser reported: ${msg}. Check the open tab and suggest a fix.` }],
        ts: ev.ts,
      };
    } else if (ev.type === 'job.failed') {
      card = {
        id: ev.id,
        title: `Background job failed: ${ev.payload?.name || ev.payload?.id || 'job'}`,
        body: String(ev.payload?.error || '').slice(0, 180),
        severity: 'error',
        actions: [{ label: 'Open Lab', prompt: `Inspect failed job ${ev.payload?.id} and recover or re-run safely.` }],
        ts: ev.ts,
      };
    } else if (ev.type === 'scheduler.due') {
      card = {
        id: ev.id,
        title: `Automation due: ${ev.payload?.label || ev.payload?.id}`,
        body: String(ev.payload?.prompt || '').slice(0, 160),
        severity: 'intent',
        actions: [{ label: 'Run now', prompt: `Run the scheduled automation "${ev.payload?.label || ev.payload?.id}" now and report results.` }],
        ts: ev.ts,
      };
    } else if (ev.type === 'briefing.ready') {
      card = {
        id: ev.id,
        title: 'Morning briefing ready',
        body: 'Cognitive sleep cycle finished consolidating notes.',
        severity: 'intent',
        actions: [{ label: 'Show briefing', prompt: 'Show the latest morning briefing and highlight anything urgent.' }],
        ts: ev.ts,
      };
    }
    if (card) {
      cards.push(card);
      if (cards.length >= limit) break;
    }
  }
  return cards;
}

export function clear() {
  memory.length = 0;
  try {
    fs.writeFileSync(LOG, '');
  } catch {}
}

// Convenience emitters used by other modules
export const bus = {
  terminalError: (payload) => emit('terminal.error', payload, { severity: 'error', source: 'terminal' }),
  shellExit: (payload) => emit('shell.exit', payload, { severity: payload?.code ? 'error' : 'info', source: 'terminal' }),
  browserError: (payload) => emit('browser.error', payload, { severity: 'warn', source: 'browser' }),
  jobFailed: (payload) => emit('job.failed', payload, { severity: 'error', source: 'lab' }),
  schedulerDue: (payload) => emit('scheduler.due', payload, { severity: 'intent', source: 'scheduler' }),
  briefingReady: (payload) => emit('briefing.ready', payload, { severity: 'intent', source: 'brain' }),
  fileDrop: (payload) => emit('file.drop', payload, { severity: 'info', source: 'files' }),
  custom: (type, payload, opts) => emit(type, payload, opts),
};
