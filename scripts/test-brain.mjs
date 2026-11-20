// Brain contract test: store, retrieve, rank, deadline tracking, sync safety, digest.
import * as brain from '../lib/brain.js';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const file = path.resolve('data/brain.jsonl');
// Never destroy a real brain while testing: park it, restore it afterwards.
const parked = file + '.testpark';
if (fs.existsSync(file)) fs.renameSync(file, parked);
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; // must be idempotent: this runs explicitly AND on exit
  cleaned = true;
  try {
    if (fs.existsSync(parked)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.renameSync(parked, file);
    }
  } catch {}
};
process.on('exit', cleanup);

check('starts empty', brain.stats().entries, 0);

brain.add({ kind: 'preference', title: 'Prefers PowerShell over cmd on Windows', body: 'Uses Windows 11; shell is powershell 5.1.', source: 'user' });
brain.add({ kind: 'project', title: 'Urban heat island study with Google Earth Engine', body: 'SGVU lecture deck + NDVI maps, python + pptx build.', tags: ['gee', 'pptx'] });
brain.add({ kind: 'competition', title: 'ARC Prize 2026', body: 'Kaggle ARC-AGI-3', deadline: '2026-11-15T23:59:00Z' });
brain.add({ kind: 'lesson', title: 'Kaggle kernels need 30s polling, not 2s', body: 'Rate limited when polling faster; use status endpoint every 30s.' });
brain.add({ kind: 'task', title: 'Ship the Kaggle baseline notebook', body: 'tabpfn + lightgbm ensemble' });

check('entries stored', brain.stats().entries, 5);
check('kinds counted', brain.stats().byKind.competition, 1);

const hits = brain.search('kaggle polling rate limit');
check('search finds the lesson', hits[0]?.title.includes('30s polling'), true);
check('search returns something for gee', brain.search('google earth engine').length > 0, true);
check('search is empty for unrelated', brain.search('banana smoothie recipe').length, 0);

const ctx = brain.context('kaggle competition deadline');
check('context is non-empty', ctx.length > 0, true);
check('context mentions the competition', /ARC Prize/.test(ctx), true);

const prof = brain.profile();
check('profile has competitions', prof.competitions.length, 1);
check('profile has projects', prof.projects.length, 1);
check('profile has open tasks', prof.openTasks.length, 1);

const dig = brain.digest();
check('digest lists the deadline', dig.deadlines.length, 1);

// session recording is what makes it grow on its own
brain.recordSession({ role: 'core', input: 'what should I do today', answer: 'Check the ARC deadline, then run the baseline.', tools: ['brain'] });
check('session recorded', brain.stats().byKind.session, 1);

// retrieval feedback loop
const before = brain.search('kaggle')[0]?.used || 0;
brain.context('kaggle');
const after = brain.search('kaggle')[0]?.used || 0;
check('retrieval bumps usage', after >= before, true);

// deletion
const all = brain.search('a');
const target = brain.search('urban heat island')[0];
brain.remove(target.id);
check('delete works', brain.search('urban heat island').length, 0);

// sync must never import secrets
const fakeDir = path.resolve('data/fake-agent');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(
  path.join(fakeDir, 'session.jsonl'),
  [
    JSON.stringify({ role: 'user', content: 'please deploy with sk-abcdefghijklmnopqrstuvwxyz123456' }),
    JSON.stringify({ role: 'assistant', content: 'done' }),
  ].join('\n'),
);
const before2 = brain.stats().entries;
brain.syncAgents({ maxFilesPerSource: 10 });
const leaked = brain.search('sk-abcdefghijklmnop', 5);
check('sync did not import the file with a key', leaked.length, 0);
fs.rmSync(fakeDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed · brain now holds ${brain.stats().entries} entries`);
cleanup();
process.exit(fail ? 1 : 0);
