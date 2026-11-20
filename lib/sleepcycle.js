/**
 * Cognitive Sleep Cycles (Phase 3)
 * When idle or on schedule, consolidate memory/brain and generate morning briefing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, WORKSPACE } from './config.js';
import { ensureDir, log } from './util.js';
import * as eventbus from './eventbus.js';

let timer = null;
let lastRun = 0;
const MIN_GAP_MS = 6 * 3600e3; // don't spam more than every 6h unless forced

export async function runSleepCycle({ force = false, reason = 'scheduled' } = {}) {
  const now = Date.now();
  if (!force && now - lastRun < MIN_GAP_MS) {
    return { ok: true, skipped: true, reason: 'too-soon' };
  }
  lastRun = now;
  log(`cognitive sleep start (${reason})`);

  let briefing = '';
  try {
    // Prefer the tool implementation so persistence + event stay consistent
    const { TOOLS } = await import('./tools.js');
    const r = await TOOLS.morning_briefing.run({});
    briefing = r?.briefing || '';
  } catch (e) {
    briefing = `# Morning Briefing — ${new Date().toISOString().slice(0, 10)}\n\n(sleep cycle partial failure: ${e.message})\n`;
  }

  // Light consolidation: trim noisy event log if huge
  try {
    const logFile = path.join(DATA, 'events', 'bus.jsonl');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 2500) {
        fs.writeFileSync(logFile, lines.slice(-1500).join('\n') + '\n');
      }
    }
  } catch {}

  eventbus.bus.briefingReady({ date: new Date().toISOString().slice(0, 10), reason });
  log('cognitive sleep done');
  return { ok: true, briefing: briefing.slice(0, 2000), reason };
}

/**
 * Ensure a daily morning briefing automation exists (idempotent).
 * Uses the existing scheduler so it respects approval gates.
 */
export function ensureMorningSchedule(hour = 8, minute = 30) {
  return import('./scheduler.js').then((scheduler) => {
    const label = 'Cognitive morning briefing';
    const prompt = [
      'Prepare a concise, cited daily intelligence briefing using live web search and the morning_briefing tool.',
      'Cover major global headlines, science/medicine, AI/computing, space, energy/climate, and business/economics; prioritize primary sources and papers when relevant.',
      'Prefer developments from the last 48 hours, verify dates and claims by opening sources, cite direct URLs, and label uncertainty. Do not imply this is exhaustive.',
      'Then summarize open automations, memory notes, and brain deadlines. End with one evidence-backed Nexus improvement idea; research or propose it only, never install skills, change code, or alter settings automatically.',
      'Keep the whole briefing short and readable. Do not claim a competition win or other unverified outcome.',
    ].join(' ');
    const legacyPrompt = 'Run the morning_briefing tool now. Summarise open automations, memory notes, and brain deadlines. Keep it short and actionable.';
    const tasks = scheduler.list();
    const existing = tasks.find((t) => t.label === label) || tasks.find((t) => t.prompt === legacyPrompt);
    if (existing) {
      const isLegacy = existing.prompt === legacyPrompt;
      if (isLegacy) scheduler.updateTask(existing.id, { prompt, label });
      return { ok: true, existed: true, updated: isLegacy, id: existing.id };
    }
    const when = `daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const task = scheduler.create({
      when,
      label,
      prompt,
      role: 'core',
    });
    return { ok: true, created: true, id: task.id, when };
  });
}

export function startIdleWatcher({ idleMs = 45 * 60e3 } = {}) {
  // Lightweight idle heuristic: if no bus events of user activity for idleMs, optionally nap.
  // We only auto-run once per MIN_GAP and only after 02:00 local to avoid disrupting evening work.
  if (timer) clearInterval(timer);
  let lastActivity = Date.now();
  eventbus.on(() => {
    lastActivity = Date.now();
  });
  timer = setInterval(() => {
    const hour = new Date().getHours();
    if (hour >= 2 && hour < 7 && Date.now() - lastActivity > idleMs) {
      runSleepCycle({ reason: 'idle-night' }).catch(() => {});
    }
  }, 10 * 60e3);
  return () => clearInterval(timer);
}
