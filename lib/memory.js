import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { appendJsonl, readJsonl, uid, truncate } from './util.js';

const FILE = path.join(DATA, 'memory.jsonl');
const STOP = new Set(
  'the a an and or of to in for on with is are was were be been it this that i you my me our we they he she at as by from not no do does did can could would should will just about into over under than then them there here'.split(
    ' ',
  ),
);

function tokens(s) {
  return String(s)
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export function all() {
  return readJsonl(FILE);
}

export function save(text, meta = {}) {
  const entry = {
    id: uid('m_'),
    text: truncate(String(text || '').trim(), 4000),
    tags: meta.tags || [],
    scope: meta.scope || 'user',
    createdAt: new Date().toISOString(),
  };
  if (!entry.text) throw new Error('empty memory');
  appendJsonl(FILE, entry);
  return entry;
}

export function search(query, limit = 6) {
  const qTokens = [...new Set(tokens(query))];
  if (!qTokens.length) return all().slice(-limit).reverse();
  const now = Date.now();
  return all()
    .map((m) => {
      const text = String(m.text).toLowerCase();
      let score = 0;
      for (const t of qTokens) if (text.includes(t)) score += t.length > 5 ? 2 : 1;
      const ageDays = (now - Date.parse(m.createdAt || 0)) / 864e5;
      score += Math.max(0, 1 - ageDays / 90);
      return { m, score };
    })
    .filter((x) => x.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

export function remove(id) {
  const items = all().filter((m) => m.id !== id);
  fs.writeFileSync(FILE, items.map((m) => JSON.stringify(m)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  return { removed: true, remaining: items.length };
}
