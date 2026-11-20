import fs from 'node:fs';
import path from 'node:path';
import { SKILLS, saveSettings } from './config.js';
import { fetchWithTimeout, ensureDir, truncate } from './util.js';
import { search } from './search.js';
import * as skills from './skills.js';

/**
 * Skill installer.
 *
 * Two jobs: ship a useful default pack (so the assistant is not blank on day one), and let the user pull
 * new skills from the web.
 *
 * A SKILL.md is *instructions injected into the prompt* — that is a prompt-injection surface, and a
 * downloaded one can tell the agent to exfiltrate keys. So every fetched skill is scanned, always
 * installed **disabled**, and the warnings are shown before it can be enabled.
 */

const DANGER = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, label: 'tries to override system instructions' },
  { re: /curl[^\n]{0,80}\|\s*(ba)?sh/i, label: 'pipes a download into a shell' },
  { re: /Invoke-WebRequest[^\n]{0,120}iex/i, label: 'executes a downloaded script in PowerShell' },
  { re: /(send|exfiltrate|upload|post)[^\n]{0,40}(api[_\s-]?key|token|password|cookie|credential)/i, label: 'mentions sending credentials somewhere' },
  { re: /id_rsa|\.ssh\b|passwords?\.json|Login Data/i, label: 'references local credential stores' },
  { re: /base64\s+(-d|--decode)[^\n]{0,40}\|\s*(ba)?sh/i, label: 'decodes and pipes to a shell' },
  { re: /rm\s+-rf\s+(\/|~|\$HOME)\s*$/im, label: 'destructive delete of a root path' },
  { re: /(disable|bypass|turn off)[^\n]{0,30}(safety|policy|permission|approval)/i, label: 'asks to disable the permission layer' },
];

export const BUILTIN = [
  'office-decks',
  'office-docs',
  'spreadsheets',
  'pdf-work',
  'research-brief',
  'file-ops',
  'deep-research',
  'inbox-triage',
  'kaggle-runner',
];

export function scanText(text) {
  const hits = [];
  for (const d of DANGER) {
    const m = d.re.exec(text);
    if (m) hits.push({ label: d.label, sample: truncate(m[0], 120) });
  }
  return hits;
}

function parseFront(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

function slug(s) {
  return String(s || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'skill';
}

/** Fetch + validate without writing anything. */
export async function fetchSkill(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('need an http(s) URL to a SKILL.md');
  const res = await fetchWithTimeout(url, {}, 25000);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const raw = await res.text();
  if (raw.length < 40) throw new Error('that URL returned almost nothing');
  if (raw.length > 200 * 1024) throw new Error('skill is larger than 200 KB');
  if (!/^---/.test(raw.trim())) throw new Error('no front matter — this does not look like a SKILL.md');
  const meta = parseFront(raw);
  const warnings = scanText(raw);
  return {
    ok: true,
    url,
    name: meta.name || 'unnamed',
    description: meta.description || '',
    suggestedId: slug(meta.name || path.basename(new URL(url).pathname, '.md')),
    chars: raw.length,
    warnings,
    preview: truncate(raw, 4000),
    raw,
  };
}

/** Write it to disk. Disabled unless the caller explicitly enables it. */
export async function install({ url, id, enable = false }) {
  const fetched = await fetchSkill(url);
  const skillId = slug(id || fetched.suggestedId);
  const dir = path.join(SKILLS, skillId);
  ensureDir(dir);
  const source = fetched.raw || fetched.preview;
  const body =
    `---\nname: ${fetched.name}\ndescription: ${fetched.description}\nsource: ${url}\ninstalledAt: ${new Date().toISOString()}\n---\n\n` +
    source.split(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/).slice(1).join('');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');

  if (enable && !fetched.warnings.length) {
    skills.toggle(skillId, true);
  }
  return {
    ok: true,
    id: skillId,
    enabled: enable && !fetched.warnings.length,
    warnings: fetched.warnings,
    note: fetched.warnings.length
      ? 'Installed but left DISABLED: the scan found something risky. Read it before enabling.'
      : 'Installed. Review it, then enable it.',
  };
}

/** Find candidate skills on the web. Uses the configured search provider. */
export async function discover(query = 'SKILL.md agent skill') {
  const r = await search(`${query} SKILL.md github`, { max: 8 });
  return (r.results || [])
    .filter((x) => /github|gitlab|gist|raw\./i.test(x.url))
    .map((x) => ({ title: x.title, url: x.url, snippet: truncate(x.snippet || '', 200), likelyRaw: /raw\.githubusercontent|\/raw\//i.test(x.url) }));
}

/** First run: enable everything that shipped with the app, so the assistant is not blank. */
export function enableAll() {
  const ids = skills.list().map((s) => s.id);
  saveSettings({ enabledSkills: ids });
  return skills.list();
}

export function ensureDefaults() {
  const shipped = skills.list().filter((s) => BUILTIN.includes(s.id)).map((s) => s.id);
  const cur = skills.enabledIds();
  if (cur.length) return cur;
  saveSettings({ enabledSkills: shipped });
  return shipped;
}

export function installedSummary() {
  const all = skills.list();
  return {
    total: all.length,
    enabled: all.filter((s) => s.enabled).length,
    builtin: all.filter((s) => BUILTIN.includes(s.id)).map((s) => s.id),
    external: all.filter((s) => !BUILTIN.includes(s.id)).map((s) => s.id),
  };
}
