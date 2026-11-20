import fs from 'node:fs';
import path from 'node:path';
import { settings, saveSettings, WORKSPACE, SKILLS, PLATFORM } from './config.js';
import { readJson, ensureDir, truncate, writeJson } from './util.js';
import * as accounts from './accounts.js';
import * as brain from './brain.js';
import * as sessions from './sessions.js';
import * as scheduler from './scheduler.js';

/**
 * Work profile — a layer that is *about this machine and this person's job*, kept separate from the
 * generic skill pack.
 *
 * Three rules encoded here:
 *  1. The user's Codex automations are RECORDED, not executed. They stay as a read-only inventory with
 *     an explicit "mirror as a Nexus task" action. Nothing from another tool's config runs by itself.
 *  2. Skills derived from observed work live under skills/work-* so they can be disabled wholesale
 *     without touching the general pack (office-decks, pdf-work, …).
 *  3. Everything is derived from files already on this PC, and every claim carries its source.
 */

const AUTOMATIONS_DIR = path.join(WORKSPACE, 'codex_sync', 'automations');
const HOME = PLATFORM.home;

function parseToml(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*("""[\s\S]*?"""|"[\s\S]*?"|.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"""')) v = v.slice(3, -3);
    else if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v.replace(/\\n/g, '\n').trim();
  }
  return out;
}

/** Read-only inventory of the automations found on disk. */
export function automations() {
  if (!fs.existsSync(AUTOMATIONS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(AUTOMATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(AUTOMATIONS_DIR, entry.name, 'automation.toml');
    if (!fs.existsSync(file)) continue;
    let meta = {};
    try {
      meta = parseToml(fs.readFileSync(file, 'utf8'));
    } catch {}
    out.push({
      id: meta.id || entry.name,
      name: (meta.name || entry.name).replace(/^"|"$/g, '').slice(0, 120),
      kind: meta.kind || 'heartbeat',
      status: meta.status || 'UNKNOWN',
      prompt: meta.prompt || '',
      promptChars: (meta.prompt || '').length,
      file,
      source: 'codex_sync/automations',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function countFiles(dir, filter, limit = 4000) {
  let n = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    if (n >= limit || depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= limit) return;
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (filter(e.name)) {
        try {
          bytes += fs.statSync(full).size;
          n++;
        } catch {}
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, 0);
  return { dir, files: n, mb: Math.round((bytes / 1e6) * 10) / 10 };
}

/** What is actually on this PC that describes the work. Counts only — no content leaves the machine. */
export function sources() {
  const codex = countFiles(path.join(HOME, '.codex'), (n) => n.endsWith('.jsonl') || n.endsWith('.md'));
  const claude = countFiles(path.join(HOME, '.claude'), (n) => n.endsWith('.jsonl') || n.endsWith('.md'));
  const docs = countFiles(path.join(HOME, 'Documents'), (n) => /\.(md|txt|pptx|docx|xlsx|pdf|csv|py)$/i.test(n));
  const workspace = countFiles(WORKSPACE, (n) => /\.(md|json|toml|py|pptx)$/i.test(n));
  return { codex, claude, docs, workspace };
}

/** The whole picture, with provenance for each part. */
export function profile() {
  const autos = automations();
  const src = sources();
  const accs = accounts.list();
  const workSkills = listWorkSkills();
  const mirrored = scheduler.list().filter((t) => String(t.label || '').startsWith('[codex]'));
  return {
    machine: { os: PLATFORM.os, home: HOME, workspace: WORKSPACE },
    automations: autos.map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, chars: a.promptChars, file: a.file })),
    automationCount: autos.length,
    sources: src,
    accounts: accs.map((a) => ({ service: a.service, handle: a.handle, email: a.email })),
    brainEntries: brain.stats().entries,
    sessions: sessions.list(200).length,
    workSkills: workSkills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    mirroredTasks: mirrored.map((t) => ({ id: t.id, label: t.label, next: t.nextRun })),
  };
}

function listWorkSkills() {
  if (!fs.existsSync(SKILLS)) return [];
  return fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('work-'))
    .map((e) => {
      const file = path.join(SKILLS, e.name, 'SKILL.md');
      let description = '';
      let name = e.name;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const fm = raw.match(/^---([\s\S]*?)---/);
        if (fm) {
          const d = fm[1].match(/description:\s*(.*)/);
          const n = fm[1].match(/name:\s*(.*)/);
          if (d) description = d[1].trim();
          if (n) name = n[1].trim();
        }
      } catch {}
      return { id: e.name, name, description, enabled: (settings().enabledSkills || []).includes(e.name) };
    });
}

/* --------------------------------- skills --------------------------------- */

const TEMPLATES = [
  {
    id: 'work-kaggle-supervision',
    match: /kaggle|quantum|digest|submission/i,
    name: 'Kaggle supervision (this PC)',
    description: 'How this user runs Kaggle: supervise runs, never auto-submit, track quota and deadlines.',
    body: `# Kaggle supervision — observed practice

Derived from the automation inventory on this machine, not from generic advice.

## The standing rules that were found in the user's own prompts
- **Do not auto-join, accept terms, upload versions or submit.** Prepare the exact action and wait for a human decision.
- Preserve the champion score in the brain so a weaker candidate never replaces it.
- Track quota and the daily submission allowance before proposing anything.
- Stay quiet when nothing changed. Notify only on: score change, run finished/failed, deadline risk, or a validated candidate ready to submit.

## How to work
1. \`job\` tool to poll status and read logs (never \`shell\` for a long poll).
2. Read the log tail on failure; quote the first traceback, not the last line.
3. Any submission step goes through the permission gate with the exact command shown to the user.

## What "done" means
A status, a number read from the log, and the next action — not "it should work".`,
  },
  {
    id: 'work-lecture-decks',
    match: /deck|slide|lecture|teaching|mcq/i,
    name: 'Lecture decks (this PC)',
    description: 'Build teaching decks from the SGVU template with python-pptx, answers in notes, then verify the file exists.',
    body: `# Teaching decks

The workflow on this machine: \`build_template.py\` rebuilds the .potx, \`make_deck.py\` renders the deck
from an outline JSON, MCQ answers go into speaker notes, then the deck is eyeballed as images.

## Rules
- \`python-pptx\` must import; if not: \`python -m pip install --user python-pptx\`.
- Output to an absolute path, then **verify \`os.path.exists\` and size > 20 KB** before reporting success.
- Open the result in the **Viewer** app — it renders real slide images through PowerPoint.
- Never rebuild from scratch when a template exists: branding lives in the slide master.

## MCQ pattern
Answer text into \`slide.notes_slide.notes_text_frame.text\`, plus an answer key slide at the end.`,
  },
  {
    id: 'work-gee-analysis',
    match: /geoinformatics|gee|ndvi|remote sensing|gis/i,
    name: 'GEE / remote sensing (this PC)',
    description: 'Earth Engine and NDVI/UHI analysis: run as a background job, export, then verify the artifact.',
    body: `# Remote sensing work

## Pattern that works here
- \`gee_automation.py check\` / \`ndvi\` via the \`job\` tool (exports outlive a chat request).
- Never treat a started export as finished; poll the job and read the last lines.
- Save maps to the workspace so the Viewer can render them, and state the file path you actually verified.

## Honesty rules
- A map that was not written to disk does not exist. Check the path.
- Quote the date range and the sensor when reporting a statistic.`,
  },
  {
    id: 'work-funding-proposals',
    match: /funding|proposal|grant|amazon research/i,
    name: 'Funding proposals (this PC)',
    description: 'Track submitted proposals and open calls without inventing eligibility or credentials.',
    body: `# Funding proposals

## Standing state to respect
- A submitted proposal must never be re-submitted or treated as pending. Record the number and date.
- Only claim a portal was checked if the browser session actually showed it.
- Mark unknown eligibility as unknown; never invent credentials, partners or approvals.

## Work
- Search official funder pages for open calls; verify deadlines, timezone, applicant eligibility, award size and submission route.
- Draft in the funder's own format with indicative budget and a verified reference list.
- Submitting requires truthful declarations and human signatures — do not sign or certify for anyone.`,
  },
  {
    id: 'work-week-planning',
    match: /productivity|plan my week|schedule/i,
    name: 'Week planning (this PC)',
    description: 'Plan a teaching + research week with deep work in the morning and a 20% buffer.',
    body: `# Week planning

Constraints stated by the user: teaching blocks (climate analytics, spatial visualization, enterprise GIS),
labs after 14:00, PhD guidance, and research time; energy highest in the morning; hours 09:00–18:00.

## Method
- Deep work (writing, modelling) before 12:00; teaching and admin after.
- Batch similar tasks; protect a 20% buffer; explicitly flag what to drop or delegate.
- Write the plan to the project's \`.nexus/memory.md\` via the handoff button so next week starts informed.`,
  },
];

export function deriveSkills({ enable = true } = {}) {
  ensureDir(SKILLS);
  const autos = automations();
  const written = [];
  for (const t of TEMPLATES) {
    const matched = autos.filter((a) => t.match.test(`${a.id} ${a.name}`));
    if (!matched.length) continue;
    const dir = path.join(SKILLS, t.id);
    ensureDir(dir);
    const provenance = matched.map((m) => `- ${m.id} (${m.kind}, ${m.status})`).join('\n');
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(
      file,
      `---\nname: ${t.id}\ndescription: ${t.description}\nsource: derived from ${matched.length} automation(s) on this PC\n---\n\n${t.body}\n\n## Provenance\n${provenance}\n`,
      'utf8',
    );
    written.push({ id: t.id, name: t.name, from: matched.map((m) => m.id) });
  }
  if (enable) {
    const cur = new Set(settings().enabledSkills || []);
    for (const w of written) cur.add(w.id);
    saveSettings({ enabledSkills: [...cur] });
  }
  return { written, enabled: enable };
}

/* -------------------------------- mirroring ------------------------------- */

/** Turn a recorded Codex automation into a Nexus task. Explicit, labelled, reversible. */
export function mirrorAutomation(id, { when = 'daily 07:00' } = {}) {
  const auto = automations().find((a) => a.id === id);
  if (!auto) throw new Error(`no automation named ${id}`);
  const existing = scheduler.list().find((t) => t.label === `[codex] ${auto.name}`);
  if (existing) return { ok: true, already: true, task: existing };
  const task = scheduler.create({
    when,
    label: `[codex] ${auto.name}`.slice(0, 90),
    prompt:
      `${auto.prompt.slice(0, 3000)}\n\n` +
      'Rules for this mirror: never submit, join, apply, upload or accept terms automatically. Prepare the action and wait for a human decision. Stay quiet when nothing meaningful changed.',
  });
  return { ok: true, task };
}

export function unmatchMirror(taskId) {
  return scheduler.remove(taskId);
}
