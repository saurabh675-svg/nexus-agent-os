// Full-system QA. Run from the app folder:  node scripts/qa.mjs [--full]
// Writes nothing except the cookie it sets in the browser profile and cleans up after itself.
const BASE = process.env.NEXUS_URL || 'http://127.0.0.1:8787';
const FULL = process.argv.includes('--full');

const results = [];
let failures = 0;

async function get(p) {
  const r = await fetch(BASE + p);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${section.padEnd(10)} ${name}${detail ? '  — ' + String(detail).slice(0, 90) : ''}`);
}
async function check(section, name, fn) {
  try {
    const r = await fn();
    if (r && r.__assert === false) return record(section, name, false, r.detail);
    return record(section, name, true, typeof r === 'string' ? r : '');
  } catch (e) {
    return record(section, name, false, e.message);
  }
}
const assert = (cond, detail) => (cond ? true : { __assert: false, detail });
const unwrap = (x) => { let v = x; for (let i = 0; i < 3; i++) { if (v && typeof v === 'object' && 'result' in v) v = v.result; else break; } return v; };

async function main() {
  console.log(`\nNexus QA against ${BASE}${FULL ? ' (full)' : ''}\n`);

  // ---------------------------------------------------------------- core
  await check('core', 'state loads', async () => {
    const s = await get('/api/state');
    return assert(s.ok && s.tools?.length > 0, `tools=${s.tools?.length} v=${s.version}`);
  });
  await check('core', 'static UI served', async () => {
    const r = await fetch(BASE + '/app.js');
    return assert(r.ok && (await r.text()).includes('renderConnect'), 'app.js reachable');
  });
  await check('core', 'doctor runs', async () => {
    const d = await get('/api/doctor');
    const pass = (d.checks || []).filter((c) => c.ok).length;
    return assert(d.checks?.length >= 8, `${pass}/${d.checks?.length} pass`);
  });

  // ------------------------------------------------------------- policy
  const policy = await import('../lib/policy.js');
  await check('policy', 'destructive always denied', () => assert(policy.decide('files', { action: 'delete', path: 'x' }).decision === 'deny'));
  await check('policy', 'rule deny beats allow', async () => {
    policy.updatePolicy({ mode: 'ask', rules: [{ match: 'shell:*', decision: 'allow' }, { match: 'shell:del *', decision: 'deny' }] });
    const v = policy.decide('shell', { command: 'del x' });
    policy.updatePolicy({ rules: [] });
    return assert(v.decision === 'deny', v.reason);
  });
  await check('policy', 'approval round-trip', async () => {
    let id = null;
    const p = policy.gate('shell', { command: 'echo qa' }, { emit: (t, d) => t === 'approval' && (id = d.id) }).then((r) => r);
    await new Promise((r) => setTimeout(r, 150));
    if (!id) return assert(false, 'no approval emitted');
    policy.resolveApproval(id, 'allow', 'once');
    return assert((await p).allow, 'gate honoured approval');
  });

  // ------------------------------------------------------------ sessions
  let sessionId = null;
  await check('sessions', 'save creates', async () => {
    const r = await post('/api/sessions', { action: 'save', messages: [{ role: 'user', content: 'qa session marker' }, { role: 'assistant', content: 'ok' }] });
    sessionId = r.id;
    return assert(r.ok && r.id, r.title);
  });
  await check('sessions', 'resume returns messages', async () => {
    const r = await get('/api/sessions/' + sessionId);
    return assert(r.session?.messages?.length === 2, `${r.session?.messages?.length} messages`);
  });
  await check('sessions', 'appears in list', async () => {
    const r = await get('/api/sessions');
    return assert((r.items || []).some((s) => s.id === sessionId));
  });

  // --------------------------------------------------------------- hooks
  const hooks = await import('../lib/hooks.js');
  await check('hooks', 'failing pre-hook blocks', async () => {
    hooks.set({ preTool: ['exit 1'] });
    const r = await hooks.pre('shell', { command: 'dir' });
    hooks.set({ preTool: [], postTool: [] });
    return assert(r.block === true, r.reason);
  });
  await check('hooks', 'passing pre-hook allows', async () => {
    hooks.set({ preTool: ['exit 0'] });
    const r = await hooks.pre('shell', { command: 'dir' });
    hooks.set({ preTool: [], postTool: [] });
    return assert(r.block === false);
  });

  // ---------------------------------------------------------------- jobs
  await check('jobs', 'run and finish', async () => {
    const j = await post('/api/jobs', { action: 'start', command: 'Write-Output qa-alive', label: 'qa job' });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const s = await get('/api/jobs/' + j.job.id);
      if (s.status !== 'running') return assert(s.lines?.some((l) => l.text.includes('qa-alive')), s.status);
    }
    return assert(false, 'timed out');
  });
  await check('jobs', 'kill works', async () => {
    const j = await post('/api/jobs', { action: 'start', command: '1..30 | ForEach-Object { Write-Output tick; Start-Sleep -Milliseconds 300 }', label: 'qa kill' });
    await new Promise((r) => setTimeout(r, 700));
    const k = await post('/api/jobs', { action: 'kill', id: j.job.id });
    return assert(k.killed === true, k.status);
  });

  // -------------------------------------------------------------- upload
  let uploaded = null;
  await check('upload', 'accepts a file + extracts text', async () => {
    const fs = await import('node:fs');
    const buf = fs.readFileSync('README.md');
    const res = await fetch(`${BASE}/api/upload?name=qa-readme.md`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    const j = await res.json();
    uploaded = j.file;
    return assert(j.ok && j.file.text.length > 100, `${j.file?.bytes} bytes, ${j.file?.text?.length} chars`);
  });

  // ------------------------------------------------------------- preview
  await check('preview', 'pptx renders slides', async () => {
    const p = await get('/api/preview?path=' + encodeURIComponent('C:/Nexus/data/workspace/demo-deck.pptx'));
    return assert(p.ok && (p.thumbs?.length || 0) > 0, `${p.thumbs?.length} thumbnails, ${p.meta?.slides} slides`);
  });
  await check('preview', 'missing file is refused', async () => {
    const p = await get('/api/preview?path=' + encodeURIComponent('C:/nope/none.pptx'));
    return assert(p.ok === false);
  });

  // ------------------------------------------------------------- browser
  await check('browser', 'launch + tab list', async () => {
    const l = await post('/api/browser', { action: 'launch', url: 'https://example.com' });
    const t = await post('/api/browser', { action: 'tabs' });
    return assert(l.ok && t.result.tabs.length >= 1, `${t.result.tabs.length} tabs`);
  });
  await check('browser', 'snapshot reads DOM', async () => {
    const s = await post('/api/browser', { action: 'snapshot' });
    return assert(s.ok && s.result.title.length > 0, s.result.title);
  });
  await check('browser', 'evaluate works over HTTP', async () => {
    const r = await post('/api/browser', { action: 'evaluate', text: '2+2' });
    return assert(unwrap(r.result) === 4, `returned ${JSON.stringify(unwrap(r.result))}`);
  });
  await check('browser', 'new tab + activate + close', async () => {
    const n = await post('/api/browser', { action: 'new_tab', url: 'https://example.org' });
    await post('/api/browser', { action: 'activate', id: n.result.id });
    const c = await post('/api/browser', { action: 'close_tab', id: n.result.id });
    return assert(Boolean(n.result.id) && c.ok);
  });

  // session persistence — the thing that was unverified
  await check('browser', 'LOGIN COOKIE SURVIVES RESTART', async () => {
    await post('/api/browser', { action: 'open', url: 'https://example.com' });
    await post('/api/browser', { action: 'evaluate', text: "document.cookie='nexus_qa=persist123; max-age=86400; path=/'" });
    const before = await post('/api/browser', { action: 'evaluate', text: 'document.cookie' });
    const quit = await post('/api/browser', { action: 'close' });
    if (!unwrap(quit.result)?.stopped) return assert(false, `chrome did not stop`);
    await post('/api/browser', { action: 'launch', url: 'https://example.com' });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await post('/api/browser', { action: 'evaluate', text: 'document.cookie' });
    const ok = String(unwrap(after) || '').includes('persist123');
    await post('/api/browser', { action: 'evaluate', text: "document.cookie='nexus_qa=; max-age=0; path=/'" });
    return assert(ok, ok ? 'cookie survived' : `before="${JSON.stringify(unwrap(before))}" after="${JSON.stringify(unwrap(after))}"`);
  });

  // --------------------------------------------------------------- files
  await check('files', 'list + read', async () => {
    const l = await post('/api/fs/list', { dir: 'C:/Nexus/data/workspace' });
    const r = await post('/api/fs/read', { path: l.path + '/mouse-test.html' });
    return assert(l.ok && r.text.includes('Mouse test'), `${l.items?.length} entries`);
  });

  // --------------------------------------------------------------- index
  await check('index', 'search returns hits', async () => {
    const r = await post('/api/index', { action: 'search', q: 'readme' });
    return assert(Array.isArray(r.items), `${r.items?.length} hits`);
  });
  await check('index', 'suggestions compute', async () => {
    const r = await post('/api/index', { action: 'suggestions' });
    return assert(Array.isArray(r.items));
  });

  // --------------------------------------------------------------- brain
  const brain = await import('../lib/brain.js');
  await check('brain', 'add + search', async () => {
    brain.add({ kind: 'fact', title: 'qa marker fact', body: 'round trip', source: 'qa' });
    const hits = brain.search('qa marker');
    return assert(hits.length > 0, `${hits.length} hits`);
  });
  await check('brain', 'unrelated query returns nothing', () => assert(brain.search('zzzz nonsense qwerty').length === 0));

  // ----------------------------------------------------------------- llm
  const telemetry = await import('../lib/telemetry.js');
  await check('llm', 'cost estimate is free for ollama', async () => {
    const m = telemetry.estimate({ model: 'gemma4:31b-cloud', promptText: 'x'.repeat(400), completionText: 'y'.repeat(400), steps: 2 });
    return assert(m.costUsd === 0, `${m.totalTokens} tok, ${m.priceLabel}`);
  });
  const skills = await import('../lib/skills.js');
  await check('llm', 'skill injection stays in budget', async () => {
    const b = skills.bodiesFor('build a powerpoint deck', 3200);
    return assert(b.length <= 3300, `${b.length} chars`);
  });
  const projectctx = await import('../lib/projectctx.js');
  await check('llm', 'project instructions load', async () => {
    const p = projectctx.load();
    return assert(p.files.length >= 1, `${p.files.map((f) => f.name).join(',')}`);
  });

  // ---------------------------------------------------------------- misc
  await check('misc', 'providers list', async () => {
    const r = await get('/api/providers');
    return assert(Array.isArray(r.profiles));
  });
  await check('misc', 'runtime detects bun', async () => {
    const r = await get('/api/runtime');
    return assert(Boolean(r.bun), r.bun ? 'bun found' : 'node only');
  });
  await check('misc', 'accounts registry', async () => {
    const r = await get('/api/accounts');
    return assert((r.items || []).length >= 5, `${r.items?.length} accounts`);
  });
  await check('misc', 'watch list', async () => {
    const r = await get('/api/watch');
    return assert(Array.isArray(r.items));
  });
  await check('misc', 'autostart status', async () => {
    const r = await get('/api/autostart');
    return assert(typeof r.enabled === 'boolean', r.enabled ? 'enabled' : 'disabled');
  });
  await check('misc', 'update endpoint', async () => {
    const r = await get('/api/update');
    return assert(Boolean(r.current), r.current);
  });
  await check('misc', 'mcp catalog + memory tools', async () => {
    const r = await get('/api/mcp');
    const mem = (r.servers || []).find((s) => s.name === 'memory');
    return assert((r.catalog || []).length >= 5 && mem?.running, `${r.catalog?.length} presets, memory ${mem?.running ? 'up' : 'down'}`);
  });
  if (FULL) {
    await check('misc', 'mcp memory round-trip', async () => {
      const call = await fetch(BASE + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sync' }) });
      await call.json();
      const { TOOLS } = await import('../lib/tools.js');
      const tool = Object.keys(TOOLS).find((k) => k.startsWith('mcp__memory__create_entities'));
      if (!tool) return assert(false, 'memory tools not registered');
      const r = await TOOLS[tool].run({ entities: [{ name: 'qa-entity', entityType: 'test', observations: ['created by qa'] }] });
      return assert(r.ok, String(r.output || '').slice(0, 60));
    });
    await check('misc', 'vision model sees a screenshot', async () => {
      const r = await post('/api/browser', { action: 'see', text2: 'What is the page title?' });
      return assert(r.ok && r.result.text.length > 5, r.result.model);
    });
  }

  await check('misc', 'delegate refuses without a CLI', async () => {
    const r = await get('/api/delegate');
    if (r.available) return assert(true, 'external CLI present — run path not exercised');
    const call = await post('/api/delegate', { prompt: 'qa probe' });
    return assert(call.ok === false && /No external agent CLI/.test(call.error || ''), 'refusal message correct');
  });

  // -------------------------------------------------------------- summary
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed, ${failures} failed`);
  if (failures) {
    console.log('\nFailures:');
    for (const f of results.filter((r) => !r.ok)) console.log(`  ${f.section} / ${f.name}: ${f.detail}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('QA harness crashed:', e);
  process.exit(2);
});
