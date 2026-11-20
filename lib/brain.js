import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT, PLATFORM } from './config.js';
import { appendJsonl, readJsonl, readJson, writeJson, uid, truncate, ensureDir, log } from './util.js';

/**
 * The brain: a local knowledge store about you, your work and the world you track.
 *
 * Deliberately not a vector database and not a cloud service — on a single PC, a token index plus
 * recency/salience scoring retrieves better than embeddings for the sizes involved (hundreds to low
 * thousands of entries), has zero dependencies, and can be inspected by a human.
 *
 * Everything lives in data/brain.jsonl. Nothing is uploaded. Deleting that file deletes the brain.
 */

const FILE = path.join(DATA, 'brain.jsonl');
const SYNC_STATE = path.join(DATA, 'brain-sync.json');

export const KINDS = ['fact', 'project', 'task', 'decision', 'lesson', 'competition', 'person', 'source', 'preference', 'session'];

const STOP = new Set(
  'the a an and or of to in for on with is are was were be been it this that i you my me our we they he she at as by from not no do does did can could would should will just about into over under than then them there here what how why when which who'.split(
    ' ',
  ),
);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f+#.]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

let index = null;

function all() {
  if (index) return index;
  index = readJsonl(FILE).filter(Boolean);
  return index;
}

export function stats() {
  const items = all();
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  const lastSync = readJson(SYNC_STATE, {});
  return {
    entries: items.length,
    byKind,
    file: FILE,
    updatedAt: items.length ? items[items.length - 1].createdAt : null,
    sources: [...new Set(items.map((i) => i.source).filter(Boolean))].slice(0, 20),
    lastSync,
  };
}

export function add({ kind = 'fact', title = '', body = '', tags = [], source = 'user', confidence = 'medium', meta = {}, deadline } = {}) {
  const text = String(body || title || '').trim();
  if (!text) throw new Error('brain entry needs text');
  const cleanTitle =
    String(title || text.split('\n')[0])
      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, ' ')
      .replace(/^#+\s*/gm, '')
      .replace(/[`*>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'untitled';
  const src = String(source || 'user').slice(0, 60);
  const dup = all().find((x) => x.title === cleanTitle && x.source === src);
  if (dup) return dup;
  const entry = {
    id: uid('b_'),
    kind: KINDS.includes(kind) ? kind : 'fact',
    title: cleanTitle,
    body: truncate(text, 6000),
    tags: Array.isArray(tags) ? tags.slice(0, 12) : String(tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    source: src,
    confidence,
    createdAt: new Date().toISOString(),
    used: 0,
    meta: { ...meta, ...(deadline ? { deadline } : {}) },
  };
  appendJsonl(FILE, entry);
  if (index) index.push(entry);
  return entry;
}

export function update(id, patch = {}) {
  const items = all();
  const rec = items.find((i) => i.id === id);
  if (!rec) throw new Error('entry not found');
  Object.assign(rec, {
    title: patch.title !== undefined ? truncate(String(patch.title), 180) : rec.title,
    body: patch.body !== undefined ? truncate(String(patch.body), 6000) : rec.body,
    kind: patch.kind || rec.kind,
    tags: patch.tags || rec.tags,
    updatedAt: new Date().toISOString(),
  });
  persist();
  return rec;
}

export function remove(id) {
  const items = all().filter((i) => i.id !== id);
  index = items;
  persist();
  return { removed: id, remaining: items.length };
}

function persist() {
  ensureDir(DATA);
  fs.writeFileSync(FILE, all().map((i) => JSON.stringify(i)).join('\n') + (all().length ? '\n' : ''), 'utf8');
}

/** BM25-lite: term frequency with field weights, IDF, recency and salience boosts. */
export function search(query, limit = 8) {
  const q = tokens(query);
  const items = all();
  if (!items.length) return [];
  if (!q.length) {
    return [...items].slice(-limit).reverse();
  }
  const df = new Map();
  for (const it of items) {
    const seen = new Set(tokens(`${it.title} ${it.body} ${(it.tags || []).join(' ')}`));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = items.length;
  const now = Date.now();
  const scored = items.map((it) => {
    const titleT = tokens(it.title);
    const bodyT = tokens(it.body);
    const tagT = tokens((it.tags || []).join(' '));
    let score = 0;
    for (const t of q) {
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      const tf = (titleT.filter((x) => x === t).length * 4 + tagT.filter((x) => x === t).length * 3 + bodyT.filter((x) => x === t).length) / (1 + bodyT.length / 400);
      score += idf * tf;
    }
    // Boosts only refine an existing lexical match — they must never surface an unrelated memory.
    if (score <= 0) return { it, score: 0 };
    const ageDays = (now - Date.parse(it.createdAt || 0)) / 864e5;
    score += Math.max(0, 1.5 - ageDays / 60);
    score += Math.min((it.used || 0) * 0.05, 0.6);
    if (it.kind === 'preference' || it.kind === 'decision') score *= 1.15;
    return { it, score };
  });
  return scored
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.it);
}

/** Mark retrieval so frequently useful entries float up over time. */
function bumpUsed(ids) {
  if (!ids.length) return;
  let changed = false;
  for (const it of all()) {
    if (ids.includes(it.id)) {
      it.used = (it.used || 0) + 1;
      changed = true;
    }
  }
  if (changed) {
    try {
      persist();
    } catch {}
  }
}

/** The block injected into every agent prompt. */
export function context(query = '', budget = 2600) {
  const hits = search(query, 10);
  if (!hits.length) return '';
  const lines = [];
  let used = 0;
  for (const h of hits) {
    const line = `- [${h.kind}] ${h.title}${h.body && h.body !== h.title ? ': ' + truncate(h.body.replace(/\s+/g, ' '), 240) : ''}`;
    if (used + line.length > budget) break;
    used += line.length;
    lines.push(line);
  }
  bumpUsed(hits.slice(0, 6).map((h) => h.id));
  return lines.join('\n');
}

/** What the agent should know about the person, independent of the current question. */
export function profile() {
  const items = all();
  const prefs = items.filter((i) => i.kind === 'preference').slice(-12);
  const projects = items.filter((i) => i.kind === 'project').slice(-8);
  const open = items.filter((i) => i.kind === 'task' && !i.meta?.done).slice(-12);
  const comps = items
    .filter((i) => i.kind === 'competition' && i.meta?.deadline)
    .filter((i) => Date.parse(i.meta.deadline) > Date.now() - 864e5)
    .sort((a, b) => Date.parse(a.meta.deadline) - Date.parse(b.meta.deadline))
    .slice(0, 6);
  const recentDecisions = items.filter((i) => i.kind === 'decision').slice(-6);

  const fmt = (i) => `- ${i.title}${i.meta?.deadline ? ` (deadline ${String(i.meta.deadline).slice(0, 10)})` : ''}`;
  return {
    counts: stats().byKind,
    preferences: prefs.map(fmt),
    projects: projects.map(fmt),
    openTasks: open.map(fmt),
    competitions: comps.map(fmt),
    decisions: recentDecisions.map(fmt),
  };
}

export function profileText() {
  const p = profile();
  const parts = [];
  if (p.preferences.length) parts.push(`Preferences:\n${p.preferences.join('\n')}`);
  if (p.projects.length) parts.push(`Active projects:\n${p.projects.join('\n')}`);
  if (p.openTasks.length) parts.push(`Open tasks:\n${p.openTasks.join('\n')}`);
  if (p.competitions.length) parts.push(`Tracked competitions:\n${p.competitions.join('\n')}`);
  if (p.decisions.length) parts.push(`Recent decisions:\n${p.decisions.join('\n')}`);
  return parts.join('\n\n');
}

/** Auto-grow: every finished conversation becomes a retrievable session entry. */
export function recordSession({ role = 'core', input = '', answer = '', tools = [] } = {}) {
  const question = String(input || '').replace(/\s+/g, ' ').trim();
  if (!question) return null;
  const summary = String(answer || '').replace(/\s+/g, ' ').trim();
  return add({
    kind: 'session',
    title: truncate(question, 160),
    body: `Q: ${truncate(question, 600)}\nA: ${truncate(summary, 1400)}${tools.length ? `\nTools: ${tools.join(', ')}` : ''}`,
    source: `chat:${role}`,
    tags: ['session'],
    confidence: 'low',
  });
}

/* ---------------------------------- sync --------------------------------- */

const SOURCES = [
  { id: 'codex', label: 'Codex', dirs: [path.join(PLATFORM.home, '.codex')], exts: ['.jsonl', '.md'] },
  { id: 'claude', label: 'Claude Code', dirs: [path.join(PLATFORM.home, '.claude')], exts: ['.jsonl', '.md'] },
  { id: 'workspace', label: 'This workspace', dirs: [ROOT], exts: ['.md'], maxDepth: 2 },
];

function walk(dir, exts, out, depth = 0, maxDepth = 4) {
  if (depth > maxDepth || out.length >= 500) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= 500) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data' || e.name === 'chrome-profile') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out, depth + 1, maxDepth);
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

function summarizeSession(text) {
  const lines = text.split('\n').filter(Boolean);
  let firstUser = '';
  let lastAssistant = '';
  let preambleTail = '';
  const tools = new Set();

  // Formats differ wildly (Codex rollouts nest role/text inside payload, Claude Code nests inside
  // message). Instead of hard-coding each schema, pull role + every "text" field out of the raw JSON.
  const extract = (m) => {
    const raw = JSON.stringify(m);
    const roleMatch = raw.match(/"role"\s*:\s*"(user|assistant|system|tool)"/);
    let role = roleMatch ? roleMatch[1] : '';
    if (!role) {
      const t = String(m.type || m.message?.type || '');
      if (/user/i.test(t)) role = 'user';
      else if (/assistant/i.test(t)) role = 'assistant';
    }
    const texts = [];
    for (const hit of raw.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        const decoded = JSON.parse(`"${hit[1]}"`);
        if (decoded && decoded.trim()) texts.push(decoded);
      } catch {}
    }
    if (!texts.length) {
      const c = m.content ?? m.message?.content ?? m.text;
      if (typeof c === 'string' && c.trim()) texts.push(c);
    }
    if (!texts.length) {
      const c = m.content ?? m.message?.content;
      if (Array.isArray(c)) {
        const flat = c.map((x) => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean).join(' ');
        if (flat.trim()) texts.push(flat);
      }
    }
    return { role, content: texts.join(' ').trim() };
  };

  for (const line of lines.slice(0, 4000)) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const { role, content } = extract(m);
    // Codex prepends its whole AGENTS.md + environment context inside the first user turn.
    const clean = content
      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, ' ')
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
      .replace(/^#*\s*AGENTS\.md instructions\s*/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isPreamble = /AGENTS\.md instructions|environment_context/i.test(content) || /^#\s*AGENTS\.md/i.test(content);
    if (role === 'user' && !firstUser && clean && !isPreamble) firstUser = clean;
    if (role === 'user' && isPreamble && clean) preambleTail = clean.slice(-260);
    if (role === 'assistant' && clean) lastAssistant = clean;
    const raw = JSON.stringify(m);
    for (const key of ['"name"', '"tool_name"', '"recipient_name"']) {
      const re = new RegExp(`${key}\\s*:\\s*"([^"]{1,60})"`, 'g');
      for (const hit of raw.matchAll(re)) tools.add(hit[1]);
    }
  }
  return {
    firstUser: truncate(firstUser || preambleTail, 300),
    lastAssistant: truncate(lastAssistant, 1200),
    tools: [...tools].slice(0, 8),
  };
}

/**
 * Read what the other local agents did. Read-only, bounded, and it only stores short summaries —
 * never full transcripts, and never anything that looks like a secret.
 */
export function syncAgents({ maxFilesPerSource = 40 } = {}) {
  const state = readJson(SYNC_STATE, { files: {} });
  const report = [];
  const secrets = /(sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z\-_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

  for (const src of SOURCES) {
    let added = 0;
    let scanned = 0;
    for (const dir of src.dirs) {
      if (!fs.existsSync(dir)) {
        report.push({ source: src.id, found: false, dir });
        continue;
      }
      const files = [];
      walk(dir, src.exts, files, 0, src.maxDepth ?? 4);
      // Session transcripts carry the most signal — scan the newest of those first.
      const weight = (f) => (f.endsWith('.jsonl') ? 0 : 1);
      files.sort((a, b) => {
        const wa = weight(a);
        const wb = weight(b);
        if (wa !== wb) return wa - wb;
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
      for (const file of files.slice(0, maxFilesPerSource)) {
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        scanned++;
        const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        if (state.files[file] === stamp) continue;
        if (stat.size > 4 * 1024 * 1024) {
          state.files[file] = stamp;
          continue;
        }
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (secrets.test(text)) {
          state.files[file] = stamp;
          report.push({ source: src.id, skipped: 'contains what looks like a secret', file: path.basename(file) });
          continue;
        }
        if (file.endsWith('.md')) {
          const label = /SKILL\.md$/i.test(file) ? `${path.basename(path.dirname(file))}/SKILL.md` : path.basename(file);
          add({
            kind: /agents|claude/i.test(label) ? 'preference' : 'fact',
            title: `${src.label}: ${label}`,
            body: truncate(text, 1800),
            source: src.id,
            tags: [src.id, 'instructions'],
            confidence: 'medium',
          });
          added++;
        } else {
          const s = summarizeSession(text);
          const harnessNoise = /^(The following is the Codex agent history|<|You are Codex|\{"|schema)/i.test(s.firstUser || '');
          if (!s.firstUser && !s.lastAssistant) {
            state.files[file] = stamp;
            continue;
          }
          if (harnessNoise) {
            state.files[file] = stamp;
            continue;
          }
          add({
            kind: 'session',
            title: `${src.label}: ${truncate(s.firstUser || path.basename(file), 120)}`,
            body: `Asked: ${s.firstUser}\nOutcome: ${s.lastAssistant}${s.tools.length ? `\nTools: ${s.tools.join(', ')}` : ''}`,
            source: src.id,
            tags: [src.id, 'synced'],
            confidence: 'low',
            meta: { file, from: src.label },
          });
          added++;
        }
        state.files[file] = stamp;
      }
    }
    report.push({ source: src.id, found: true, scanned, added });
  }
  state.lastSync = new Date().toISOString();
  writeJson(SYNC_STATE, state);
  log(`brain sync: ${report.map((r) => `${r.source}:${r.added ?? 0}`).join(' ')}`);
  return report;
}

/** Today's brief: what is due, what is tracked, what changed. */
export function digest() {
  const items = all();
  const now = Date.now();
  const soon = items
    .filter((i) => i.meta?.deadline && Date.parse(i.meta.deadline) > now)
    .sort((a, b) => Date.parse(a.meta.deadline) - Date.parse(b.meta.deadline))
    .slice(0, 8);
  const openTasks = items.filter((i) => i.kind === 'task' && !i.meta?.done).slice(-10);
  const newFacts = items.filter((i) => i.kind === 'fact' && now - Date.parse(i.createdAt) < 7 * 864e5).slice(-10);
  return { deadlines: soon, openTasks, newFacts, stats: stats() };
}
