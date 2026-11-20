import path from 'node:path';
import { DATA } from './config.js';
import { readJson, writeJson, ensureDir, uid, truncate } from './util.js';

/**
 * Opportunity pipeline.
 *
 * The whole point is the boundary. An agent may research, qualify, draft and package an entry; it may
 * NOT sign in, accept terms, submit, negotiate or take payment. Those are represented as stages that
 * only a human can move, and the code enforces that rather than trusting the prompt to.
 */

const FILE = path.join(DATA, 'pipeline.json');

export const STAGES = ['discovered', 'qualified', 'drafting', 'ready', 'awaiting_human', 'submitted', 'paid', 'skipped'];

/** First stage an agent may not set on its own. */
export const HUMAN_FROM = 'awaiting_human';

export const HUMAN_ACTIONS = {
  awaiting_human: 'sign in, accept the terms, submit — you do this, not me',
  submitted: 'confirm the submission went through',
  paid: 'confirm the money actually arrived',
};

const idx = (s) => STAGES.indexOf(s);

export function list() {
  const store = readJson(FILE, { items: {} });
  return Object.values(store.items || {}).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function save(items) {
  ensureDir(DATA);
  writeJson(FILE, { items: Object.fromEntries(items.map((i) => [i.id, i])) });
}

export function add({ title, url, kind = 'bounty', deadline = '', prize = '', source = '', fit = null } = {}) {
  if (!title) throw new Error('pipeline item needs a title');
  const items = list();
  const dup = items.find((i) => (url && i.url === url) || i.title === title);
  if (dup) return { ok: true, already: true, item: dup };
  const item = {
    id: uid('o_').slice(0, 10),
    title: String(title).slice(0, 200),
    url: String(url || ''),
    kind,
    deadline: String(deadline || ''),
    prize: String(prize || ''),
    source: String(source || ''),
    fit,
    stage: 'discovered',
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(item);
  save(items);
  return { ok: true, item };
}

/**
 * Advance a stage.
 * actor:'agent' is the default. Moving into or past HUMAN_FROM requires actor:'human' — a person
 * clicking a button in the UI — so a runaway loop cannot mark its own homework as submitted.
 */
export function advance(id, to, { actor = 'agent', note = '' } = {}) {
  const items = list();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error('no such pipeline item');
  if (!STAGES.includes(to)) throw new Error(`unknown stage "${to}"`);
  if (idx(to) < 0) throw new Error('bad stage');

  const needsHuman = idx(to) >= idx(HUMAN_FROM);
  if (needsHuman && actor !== 'human') {
    throw new Error(
      `"${to}" needs a human: ${HUMAN_ACTIONS[to] || 'human confirmation'}. I can prepare everything and stop at “ready”, but I will not submit, accept terms, or claim payment for you.`,
    );
  }
  if (idx(item.stage) >= idx(HUMAN_FROM) && to === 'drafting') {
    throw new Error('this item is already past submission — do not rework it blindly');
  }

  item.stage = to;
  item.updatedAt = new Date().toISOString();
  if (note) item.notes.push({ at: item.updatedAt, by: actor, note: truncate(note, 400) });
  save(items);
  return { ok: true, item, nextHumanAction: needsHuman ? HUMAN_ACTIONS[to] || null : null };
}

export function update(id, patch = {}) {
  const items = list();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error('no such pipeline item');
  Object.assign(item, {
    title: patch.title ? String(patch.title).slice(0, 200) : item.title,
    deadline: patch.deadline !== undefined ? String(patch.deadline) : item.deadline,
    prize: patch.prize !== undefined ? String(patch.prize) : item.prize,
    updatedAt: new Date().toISOString(),
  });
  save(items);
  return item;
}

export function remove(id) {
  const items = list().filter((i) => i.id !== id);
  save(items);
  return { removed: id, remaining: items.length };
}

/** The actionable view: what is waiting on you, what the agent can push forward itself. */
export function summary() {
  const items = list();
  const byStage = {};
  for (const s of STAGES) byStage[s] = items.filter((i) => i.stage === s).length;
  const mine = items.filter((i) => idx(i.stage) < idx(HUMAN_FROM) && i.stage !== 'skipped');
  const yours = items.filter((i) => idx(i.stage) >= idx(HUMAN_FROM) && !['submitted', 'paid', 'skipped'].includes(i.stage));
  return {
    total: items.length,
    byStage,
    agentCanAdvance: mine.map((i) => ({ id: i.id, title: i.title, stage: i.stage })),
    waitingOnYou: yours.map((i) => ({ id: i.id, title: i.title, stage: i.stage, action: HUMAN_ACTIONS[i.stage] || 'confirm' })),
    items,
  };
}
