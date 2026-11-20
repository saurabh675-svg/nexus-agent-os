import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, ROOT, WORKSPACE, settings, saveSettings } from './config.js';
import * as llm from './llm.js';

/**
 * Deck builder behind the "Decks" tool.
 *
 * Two steps, both observable:
 *   1. outline  — the model drafts the lecture as JSON in the SGVU teaching shape (concept → MCQ → answer)
 *   2. build    — scripts/sgvu_deck.py renders it onto the real SGVU template with public-domain images
 *
 * A job is a plain object in memory; the UI polls it. Nothing here blocks the server.
 */

const JOBS = new Map();
const TTL_MS = 30 * 60 * 1000;

export const TEMPLATE_CANDIDATES = [
  path.join(DATA, 'templates', 'sgvu-lecture.pptx'),
  path.join(ROOT, 'data', 'templates', 'sgvu-lecture.pptx'),
];

export function templatePath() {
  const configured = settings().decks?.template;
  if (configured && fs.existsSync(configured)) return configured;
  for (const p of TEMPLATE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

export function saveTemplatePath(file) {
  if (!fs.existsSync(file)) throw new Error('template file not found: ' + file);
  saveSettings({ decks: { template: file } });
  return file;
}

function looseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const body = raw.slice(start);
  try {
    return JSON.parse(body);
  } catch {}
  // close unclosed braces, honouring strings (models frequently stop one brace early)
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const c of body) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let fixed = body;
  if (inStr) fixed += '"';
  while (stack.length) fixed += stack.pop();
  try {
    return JSON.parse(fixed);
  } catch {
    const lastBrace = body.lastIndexOf('}');
    if (lastBrace > 0) {
      try {
        return JSON.parse(fixed.slice(0, lastBrace + 1) + '}');
      } catch {}
    }
    return null;
  }
}

const SHAPE_HINT = `Return ONLY JSON, no prose, no markdown fence:
{"slides":[
 {"type":"title","image_query":"<2-4 words>","narration":"<what the lecturer says, 1-2 sentences>"},
 {"type":"objectives","title":"Learning objectives","bullets":["b1","b2","b3"],"image_query":"...","narration":"..."},
 {"type":"concept","title":"...","bullets":["b1","b2","b3","b4"],"image_query":"<optional>","narration":"..."},
 {"type":"mcq","title":"Part 1 · MCQ 1","question":"...","options":["A.  ...","B.  ...","C.  ...","D.  ..."],"narration":"..."},
 {"type":"answer","title":"Part 1 · Answer 1","correct":"Correct answer: B. ...","explanation":"...","narration":"..."}
]}
Rules: 12-16 slides. Use exactly 3 MCQ + 3 answer pairs placed after the relevant concept slide.
Bullets: at most 4 per slide, each under 90 characters, no full stops at the end optional.
image_query only where a real map/diagram would help; 2-4 plain words.`;

function fallbackOutline(topic, lecture) {
  return {
    slides: [
      { type: 'title', image_query: topic.split(' ').slice(0, 2).join(' '), narration: `Today we study ${topic}.` },
      {
        type: 'objectives',
        title: 'Learning objectives',
        bullets: [`Define ${topic}.`, 'Select the right method for the data.', 'Recognise the common pitfalls.'],
        narration: `By the end of this lecture you should be able to define ${topic}, choose a method deliberately, and name its limits.`,
      },
      {
        type: 'concept',
        title: `What is ${topic}?`,
        bullets: ['Definition in one line.', 'What data it needs.', 'Where it is used in practice.', 'What it cannot show.'],
        narration: `Start with the definition, then the data it needs, then its limits.`,
      },
      {
        type: 'concept',
        title: 'How it is done',
        bullets: ['Data preparation.', 'Classification or transform step.', 'Symbol design.', 'Verification.'],
        narration: 'Walk the class through the four steps in order; each one can introduce error.',
      },
      {
        type: 'concept',
        title: 'Common mistakes',
        bullets: ['Wrong data type for the method.', 'Ignoring scale and aggregation.', 'Unclear legend.', 'No source line.'],
        narration: 'These four mistakes account for most weak maps in student work.',
      },
      {
        type: 'concept',
        title: 'Summary and exercise',
        bullets: [`${topic} in one sentence.`, 'Practice on your own district data.', 'Compare two method choices.', 'Report the difference.'],
        narration: 'Close with the exercise and what a good answer looks like.',
      },
    ],
  };
}

async function draftOutline(topic, lecture) {
  const prompt = `You are writing a university GIS lecture titled "${topic}" (${lecture}). Write it in the SGVU teaching style: short spoken narration in the notes, 3-4 bullets per slide, and three multiple-choice checkpoints with answer slides. ${SHAPE_HINT}`;
  const raw = await llm.complete([
    { role: 'system', content: 'You write lecture outlines as strict JSON. No commentary.' },
    { role: 'user', content: prompt },
  ]);
  const parsed = looseJson(raw);
  if (parsed && Array.isArray(parsed.slides) && parsed.slides.length >= 6) {
    return { outline: parsed, source: 'model' };
  }
  return { outline: fallbackOutline(topic, lecture), source: 'fallback' };
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    topic: job.topic,
    lecture: job.lecture,
    path: job.path,
    slides: job.slides,
    pictures: job.pictures,
    outlineSource: job.outlineSource,
    error: job.error,
    log: (job.log || '').slice(-1200),
    seconds: Math.round((Date.now() - job.startedAt) / 1000),
  };
}

export function status(id) {
  const job = JOBS.get(id);
  if (!job) return { ok: false, error: 'unknown job' };
  return { ok: true, job: publicJob(job) };
}

export function recent() {
  const out = [];
  for (const job of [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)) out.push(publicJob(job));
  return out;
}

function reap() {
  const now = Date.now();
  for (const [id, job] of JOBS) if (now - job.startedAt > TTL_MS) JOBS.delete(id);
}

export function build({ topic, lecture = 'Lecture', template, imagesPublicDomain = true }) {
  const clean = String(topic || '').trim();
  if (!clean) throw new Error('a topic is required');
  reap();
  const tpl = template && fs.existsSync(template) ? template : templatePath();
  const id = 'deck_' + crypto.randomBytes(5).toString('hex');
  const job = {
    id,
    topic: clean,
    lecture,
    state: 'outline',
    startedAt: Date.now(),
    log: '',
    template: tpl,
    imagesPublicDomain,
  };
  JOBS.set(id, job);
  run(job).catch((e) => {
    job.state = 'error';
    job.error = String(e.message || e);
    job.log += `\nERROR: ${job.error}`;
  });
  return publicJob(job);
}

async function run(job) {
  const outDir = WORKSPACE;
  fs.mkdirSync(outDir, { recursive: true });
  const slug = job.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'lecture';
  const outlinePath = path.join(outDir, `.deck-outline-${job.id}.json`);
  const outPath = path.join(outDir, `${slug}.pptx`);

  job.log += `drafting outline for "${job.topic}"\n`;
  const { outline, source } = await draftOutline(job.topic, job.lecture);
  job.outlineSource = source;

  const spec = {
    title: job.topic,
    lecture: job.lecture,
    course: 'Course Title',
    org: 'Institution Name',
    coordinator: ['Course Coordinator', '', '', ''],
    program: ['Program / Semester', 'Program Code: N/A   Credits: N/A'],
    slides: outline.slides,
  };
  fs.writeFileSync(outlinePath, JSON.stringify(spec, null, 2), 'utf8');
  job.log += `outline: ${outline.slides.length} slides (${source})\n`;

  if (!job.template) {
    job.log += 'no SGVU template found — building without branding (set one in Decks)\n';
  }

  job.state = 'building';
  const script = path.join(ROOT, 'scripts', 'sgvu_deck.py');
  const args = [script, 'build'];
  if (job.template) args.push(job.template);
  else args.push('');
  args.push(outlinePath, outPath);

  await new Promise((resolve, reject) => {
    const child = spawn(settings().python || 'python', args, { cwd: ROOT, windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error('deck build timed out after 8 minutes'));
    }, 8 * 60 * 1000);
    child.stdout.on('data', (d) => (job.log += d.toString()));
    child.stderr.on('data', (d) => (job.log += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('cannot run python: ' + e.message));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`builder exited ${code}: ${(job.log || '').slice(-400)}`));
      resolve();
    });
  });

  const line = (job.log.match(/\{"ok":.*\}/g) || []).pop();
  let stats = {};
  try {
    stats = line ? JSON.parse(line) : {};
  } catch {}
  if (!fs.existsSync(outPath)) throw new Error('builder reported success but the file is missing');
  job.path = outPath;
  job.slides = stats.slides || null;
  job.pictures = stats.pictures || null;
  job.state = 'done';
  job.log += `\ndone: ${outPath}\n`;
  try {
    fs.unlinkSync(outlinePath);
  } catch {}
}
