import path from 'node:path';
import fs from 'node:fs';
import { DATA } from './config.js';
import { readJson, writeJson, uid, truncate, log, ensureDir } from './util.js';
import { settings } from './config.js';

const FILE = path.join(DATA, 'tasks.json');
let timer = null;
let notify = () => {};
const running = new Set();

export function setNotifier(fn) {
  notify = fn;
}

export function list() {
  return readJson(FILE, []).map((t) => ({ ...t, running: running.has(t.id) }));
}

function persist(tasks) {
  writeJson(FILE, tasks);
  notify('tasks', list());
  return tasks;
}

// Accepts: "every 30m" | "every 2h" | "hourly" | "daily 09:00" | a 5-field cron | an ISO date
export function parseWhen(when) {
  const raw = String(when || '').trim().toLowerCase();
  if (!raw) throw new Error('schedule needs "when", e.g. "every 30m" or "daily 09:00"');

  const every = raw.match(/^every\s+(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2][0];
    const ms = n * (unit === 'm' ? 60e3 : unit === 'h' ? 3600e3 : 864e5);
    return { kind: 'interval', ms, label: `every ${n}${unit}` };
  }
  if (raw === 'hourly') return { kind: 'interval', ms: 3600e3, label: 'hourly' };
  if (raw === 'daily') return { kind: 'daily', hour: 9, minute: 0, label: 'daily 09:00' };

  const daily = raw.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    return { kind: 'daily', hour: Number(daily[1]), minute: Number(daily[2]), label: `daily ${daily[1]}:${daily[2]}` };
  }

  const parts = raw.split(/\s+/);
  if (parts.length === 5 && parts.every((p) => /^[\d*/,/\-]+$/.test(p))) {
    const [mi, ho] = parts;
    if (/^\*\/\d+$/.test(mi) && ho === '*') {
      return { kind: 'interval', ms: Number(mi.slice(2)) * 60e3, label: `every ${mi.slice(2)}m` };
    }
    const minute = mi === '*' ? 0 : Number(mi);
    const hour = ho === '*' ? 9 : Number(ho);
    if (Number.isFinite(minute) && Number.isFinite(hour)) {
      return { kind: 'daily', hour, minute, label: `daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
    }
  }

  const at = Date.parse(when);
  if (Number.isFinite(at)) return { kind: 'once', at, label: `once at ${new Date(at).toLocaleString()}` };

  throw new Error(`cannot understand "${when}". Use "every 30m", "daily 09:00", "*/15 * * * *" or an ISO date.`);
}

function nextRunFor(task, from = Date.now()) {
  if (task.schedule.kind === 'interval') return from + task.schedule.ms;
  if (task.schedule.kind === 'once') return task.schedule.at;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(task.schedule.hour, task.schedule.minute, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function create({ when, prompt, label, role = 'core', useSkills = true }) {
  if (!prompt) throw new Error('schedule needs a prompt to run');
  const schedule = parseWhen(when);
  const task = {
    id: uid('t_'),
    label: label || truncate(prompt, 60),
    prompt,
    role,
    useSkills,
    schedule,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastResult: null,
    lastError: null,
    runs: 0,
    nextRun: nextRunFor({ schedule }, Date.now()),
  };
  persist([...list(), task]);
  return task;
}

export function remove(id) {
  const before = list();
  const after = before.filter((t) => t.id !== id);
  if (before.length === after.length) throw new Error('task not found');
  persist(after);
  return { removed: id };
}

export function toggle(id, enabled) {
  const tasks = list().map((t) => (t.id === id ? { ...t, enabled: Boolean(enabled) } : t));
  persist(tasks);
  return tasks.find((t) => t.id === id);
}

export async function runNow(id) {
  const task = list().find((t) => t.id === id);
  if (!task) throw new Error('task not found');
  return execute(task);
}

async function execute(task) {
  if (running.has(task.id)) return { skipped: 'already running' };
  running.add(task.id);
  const started = Date.now();
  notify('task_start', { id: task.id, label: task.label });
  try {
    const { runAgent } = await import('./agentloop.js');
    const events = [];
    const r = await runAgent({
      role: task.role || 'core',
      input: task.prompt,
      emit: (type, payload) => {
        if (type === 'tool_end') events.push(`${payload.name} ${payload.ok ? 'ok' : 'failed'} (${payload.ms}ms)`);
      },
    });
    const answer = truncate(r.answer || r.error || 'no output', 6000);
    if (task.label === 'Cognitive morning briefing' && !r.error) {
      try {
        const dir = path.join(DATA, 'briefings');
        const date = new Date().toISOString().slice(0, 10);
        ensureDir(dir);
        fs.writeFileSync(path.join(dir, 'daily-intelligence.md'), answer);
        fs.writeFileSync(path.join(dir, `${date}-daily-intelligence.md`), answer);
        notify('briefing', { date, source: 'daily-intelligence' });
      } catch (e) {
        log('daily briefing persistence failed', e.message);
      }
    }
    update(task.id, {
      lastRun: new Date().toISOString(),
      lastResult: answer,
      lastError: r.error || null,
      runs: (task.runs || 0) + 1,
      lastDurationMs: Date.now() - started,
      nextRun: task.schedule.kind === 'once' ? null : nextRunFor(task, Date.now()),
      enabled: task.schedule.kind === 'once' ? false : task.enabled,
    });
    notify('task_end', { id: task.id, label: task.label, ok: !r.error, answer: truncate(answer, 800), tools: events });
    // Out-of-band push, so a 07:00 digest is not stuck behind a closed window.
    try {
      const cfg = settings().notify || {};
      if (cfg.onTaskEnd !== false && cfg.discordChannelId) {
        const discord = await import('./discord.js');
        await discord.sendMessage(cfg.discordChannelId, `**${task.label}** ${r.error ? 'failed' : 'finished'}\n${truncate(answer, 1500)}`);
      }
      const tg = settings().telegram || {};
      if (cfg.onTaskEnd !== false && tg.token && tg.chatId) {
        await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: tg.chatId, text: `${task.label} — ${r.error ? 'failed' : 'finished'}\n\n${truncate(answer, 1500)}` }),
        });
      }
    } catch (e) {
      log('task notify failed', e.message);
    }
    log(`scheduled task done: ${task.label}`);
    return { ok: !r.error, answer, tools: events };
  } catch (e) {
    update(task.id, {
      lastRun: new Date().toISOString(),
      lastError: String(e.message || e),
      runs: (task.runs || 0) + 1,
      nextRun: task.schedule.kind === 'once' ? null : nextRunFor(task, Date.now()),
    });
    notify('task_end', { id: task.id, label: task.label, ok: false, answer: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  } finally {
    running.delete(task.id);
  }
}

function update(id, patch) {
  persist(list().map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export function updateTask(id, patch = {}) {
  const task = list().find((item) => item.id === id);
  if (!task) throw new Error('task not found');
  const next = {
    ...task,
    ...(typeof patch.label === 'string' ? { label: truncate(patch.label, 120) } : {}),
    ...(typeof patch.prompt === 'string' ? { prompt: patch.prompt } : {}),
  };
  persist(list().map((item) => item.id === id ? next : item));
  return next;
}

export function start() {
  if (timer) return;
  timer = setInterval(async () => {
    const now = Date.now();
    for (const t of list()) {
      if (!t.enabled || !t.nextRun || running.has(t.id)) continue;
      if (t.nextRun <= now) {
        execute(t).catch((e) => log('task error', e.message));
      }
    }
  }, 20000);
  timer.unref?.();
  log(`scheduler started with ${list().length} task(s)`);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
