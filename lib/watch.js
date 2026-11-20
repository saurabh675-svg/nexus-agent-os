import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './config.js';
import { readJson, writeJson, ensureDir, truncate, uid } from './util.js';
import { readPage } from './search.js';

/**
 * Change monitors.
 *
 * The user's own Codex automations say the right rule: "stay quiet when unchanged, notify only on a
 * meaningful change". So a watch stores a normalised text snapshot, and only reports when the hash
 * moves — with the newly appeared lines, so the notification is useful rather than "something changed".
 */

const FILE = path.join(DATA, 'watches.json');

function norm(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[0-9]{1,2}:\d{2}(:\d{2})?/g, '') // clock digits churn constantly
    .trim();
}

function digest(text) {
  return crypto.createHash('sha1').update(norm(text)).digest('hex');
}

export function list() {
  const store = readJson(FILE, {});
  return Object.values(store).map(({ text, ...rest }) => rest);
}

export function get(id) {
  const store = readJson(FILE, {});
  return store[id] || null;
}

export function add({ url, label, id, note = '' }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('watch needs an http(s) URL');
  const store = readJson(FILE, {});
  const wid = id || uid('w_').slice(0, 10);
  store[wid] = {
    id: wid,
    url,
    label: label || url.replace(/^https?:\/\//, '').slice(0, 60),
    note,
    addedAt: new Date().toISOString(),
    checkedAt: null,
    changes: 0,
    lastChangeAt: null,
    hash: null,
    text: '',
  };
  ensureDir(DATA);
  writeJson(FILE, store);
  return store[wid];
}

export function remove(id) {
  const store = readJson(FILE, {});
  if (!store[id]) throw new Error('no such watch');
  delete store[id];
  writeJson(FILE, store);
  return { removed: id };
}

/** Fetch and compare. Returns a structured diff-ish result; never throws for network reasons. */
export async function check(id) {
  const store = readJson(FILE, {});
  const w = store[id];
  if (!w) throw new Error('no such watch');
  let page;
  try {
    page = await readPage(w.url, 60000);
  } catch (e) {
    w.checkedAt = new Date().toISOString();
    w.error = truncate(String(e.message || e), 200);
    writeJson(FILE, store);
    return { id, ok: false, error: w.error };
  }
  const text = norm(page.text);
  if (text.length < 200) {
    w.checkedAt = new Date().toISOString();
    w.error = 'page returned almost no text (JS-only or blocked)';
    writeJson(FILE, store);
    return { id, ok: false, error: w.error, note: 'consider monitoring the RSS or a search query instead' };
  }
  const hash = digest(text);
  const first = !w.hash;
  const changed = !first && hash !== w.hash;

  // What actually appeared since last time — token-level, so it reads like a diff.
  let appeared = [];
  if (changed) {
    const before = new Set(String(w.text || '').split(' '));
    appeared = [...new Set(text.split(' '))].filter((t) => t.length > 3 && !before.has(t)).slice(0, 40);
  }

  w.hash = hash;
  w.text = text.slice(0, 400000);
  w.checkedAt = new Date().toISOString();
  w.status = page.status;
  w.error = null;
  if (changed) {
    w.changes = (w.changes || 0) + 1;
    w.lastChangeAt = w.checkedAt;
  }
  writeJson(FILE, store);
  return {
    id,
    label: w.label,
    url: w.url,
    ok: true,
    first,
    changed,
    changes: w.changes,
    appeared: appeared.slice(0, 20),
    status: page.status,
    checkedAt: w.checkedAt,
  };
}

export async function checkAll({ onlyChanged = true } = {}) {
  const items = list();
  const out = [];
  for (const w of items) {
    try {
      const r = await check(w.id);
      if (!onlyChanged || r.changed || r.first || r.ok === false) out.push(r);
    } catch (e) {
      out.push({ id: w.id, ok: false, error: String(e.message || e) });
    }
  }
  return { checked: items.length, results: out, changed: out.filter((r) => r.changed).length };
}

export function summary() {
  const items = list();
  return {
    total: items.length,
    withChanges: items.filter((i) => i.changes > 0).length,
    neverChecked: items.filter((i) => !i.checkedAt).length,
    items,
  };
}
