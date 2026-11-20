/**
 * Lightweight subagents (7.1) — parallel short runs with shared policy budgets.
 * Not full multi-agent debate; focused workers that return a summary.
 */
import { uid, truncate, log } from './util.js';
import { settings } from './config.js';
import * as eventbus from './eventbus.js';

/**
 * @param {object} opts
 * @param {string} opts.goal
 * @param {Array<{id?:string, role:string, prompt:string, tools?:string[]}>} opts.workers
 * @param {(worker, prompt) => Promise<string>} opts.runOne  - inject agent turn runner from outside
 */
export async function runParallel({ goal, workers = [], runOne, maxWorkers = 3 } = {}) {
  if (!runOne) throw new Error('subagents.runParallel needs runOne(worker, prompt)');
  const list = workers.slice(0, maxWorkers);
  if (!list.length) throw new Error('no workers');
  const started = Date.now();
  eventbus.emit('subagents.start', { goal, count: list.length }, { severity: 'info' });

  const results = await Promise.all(
    list.map(async (w, i) => {
      const id = w.id || uid('sa_');
      const prompt = [
        `You are a focused subagent (${w.role}).`,
        `Overall goal: ${goal}`,
        `Your assignment: ${w.prompt}`,
        `Reply with a concise result only. Do not invent tools you lack.`,
      ].join('\n');
      try {
        const answer = await runOne({ ...w, id }, prompt);
        return { id, role: w.role, ok: true, answer: truncate(String(answer || ''), 4000) };
      } catch (e) {
        return { id, role: w.role, ok: false, error: String(e.message || e) };
      }
    }),
  );

  const summary = results
    .map((r) => `### ${r.role} (${r.ok ? 'ok' : 'fail'})\n${r.answer || r.error || ''}`)
    .join('\n\n');

  eventbus.emit(
    'subagents.done',
    { goal, ms: Date.now() - started, ok: results.filter((r) => r.ok).length },
    { severity: 'info' },
  );
  log('subagents done', results.length);
  return { ok: true, goal, results, summary, ms: Date.now() - started };
}

/** Model routing hint — cheap vs strong (caller still picks the model). */
export function routeStep(kind) {
  const s = settings();
  const cheap = s.routing?.cheapModel || s.model || 'llama3.2';
  const strong = s.routing?.strongModel || s.openai?.model || s.model || cheap;
  if (['classify', 'extract', 'summarize', 'label'].includes(kind)) return { model: cheap, tier: 'cheap' };
  if (['plan', 'decide', 'code', 'review'].includes(kind)) return { model: strong, tier: 'strong' };
  return { model: s.model || strong, tier: 'default' };
}
