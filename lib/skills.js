import fs from 'node:fs';
import path from 'node:path';
import { SKILLS, settings, saveSettings } from './config.js';
import { ensureDir, truncate } from './util.js';

/** Parse `--- name: ... ---` front matter without a YAML dependency. */
function frontMatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function list() {
  ensureDir(SKILLS);
  const out = [];
  for (const entry of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    let dir = path.join(SKILLS, entry.name);
    let file = null;
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) file = path.join(dir, 'SKILL.md');
    } else if (entry.name.toLowerCase().endsWith('.md') && entry.name !== 'README.md') {
      file = dir;
    }
    if (!file) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = frontMatter(raw);
    out.push({
      id: entry.isDirectory() ? entry.name : path.basename(entry.name, '.md'),
      name: meta.name || (entry.isDirectory() ? entry.name : path.basename(entry.name, '.md')),
      description: meta.description || body.trim().split('\n')[0].slice(0, 180),
      path: file,
      chars: raw.length,
      enabled: enabledIds().includes(meta.name || entry.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function enabledIds() {
  const s = settings();
  if (!Array.isArray(s.enabledSkills)) s.enabledSkills = [];
  return s.enabledSkills;
}

export function toggle(id, on) {
  const cur = new Set(enabledIds());
  if (on) cur.add(id);
  else cur.delete(id);
  saveSettings({ enabledSkills: [...cur] });
  return list();
}

export function load(id) {
  const found = list().find((s) => s.id === id || s.name === id);
  if (!found) throw new Error(`skill not found: ${id}`);
  const raw = fs.readFileSync(found.path, 'utf8');
  const { body } = frontMatter(raw);
  return { ...found, body: truncate(body.trim(), 12000) };
}

/** Short menu injected into the system prompt. */
export function menu() {
  const enabled = list().filter((s) => s.enabled);
  if (!enabled.length) return '';
  return enabled.map((s) => `- ${s.id}: ${s.description}`).join('\n');
}

/** Full text of all enabled skills, capped so small local models still fit context. */
export function enabledBodies(totalBudget = 7000) {
  const enabled = list().filter((s) => s.enabled);
  let used = 0;
  const parts = [];
  for (const s of enabled) {
    const body = load(s.id).body;
    if (used + body.length > totalBudget) break;
    used += body.length;
    parts.push(`### SKILL: ${s.id}\n${body}`);
  }
  return parts.join('\n\n');
}

/**
 * Relevance-ranked injection.
 *
 * Nine enabled skills was measured at ~7k characters added to EVERY step, which is what made replies
 * slow. Rank by the question, skip anything that does not fit the budget, and never inline all of them.
 */
export function bodiesFor(query = '', budget = 3200) {
  const enabled = list().filter((s) => s.enabled);
  if (!enabled.length) return '';
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const scored = enabled
    .map((s) => {
      const hay = `${s.id} ${s.name} ${s.description}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 3;
      if (/deck|slide|ppt|powerpoint/i.test(query) && s.id === 'office-decks') score += 8;
      if (/docx|word|report|letter/i.test(query) && s.id === 'office-docs') score += 8;
      if (/excel|xlsx|csv|spreadsheet/i.test(query) && s.id === 'spreadsheets') score += 8;
      if (/pdf/i.test(query) && s.id === 'pdf-work') score += 8;
      if (/kaggle|kernel|submission/i.test(query) && s.id === 'kaggle-runner') score += 8;
      if (/research|source|cite|verify/i.test(query) && /research|deep/i.test(s.id)) score += 6;
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);

  let used = 0;
  const parts = [];
  for (const { s } of scored) {
    const body = load(s.id).body;
    if (used + body.length > budget) continue;
    used += body.length;
    parts.push(`### SKILL: ${s.id}\n${body}`);
  }
  return parts.join('\n\n');
}
