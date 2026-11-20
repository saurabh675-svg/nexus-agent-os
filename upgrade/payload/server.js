import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import {
  PORT,
  DATA,
  PUBLIC,
  ROOT,
  WORKSPACE,
  SKILLS,
  settings,
  saveSettings,
  publicSettings,
  unmaskSettings,
  ollamaBin,
  chromeBin,
  PLATFORM,
} from './lib/config.js';
import { sse, readJson, writeJson, truncate, log, ensureDir, fetchWithTimeout } from './lib/util.js';

const PKG = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0' };
  }
})();
import { search, readPage } from './lib/search.js';
import * as llm from './lib/llm.js';
import * as browser from './lib/browser.js';
import * as google from './lib/google.js';
import * as kaggle from './lib/kaggle.js';
import * as memory from './lib/memory.js';
import * as skills from './lib/skills.js';
import * as scheduler from './lib/scheduler.js';
import { runAgent, runCluster, roles } from './lib/agentloop.js';
import { TOOLS, runShell } from './lib/tools.js';
import * as policy from './lib/policy.js';
import * as eventbus from './lib/eventbus.js';
import * as workspaces from './lib/workspaces.js';
import * as recipes from './lib/recipes.js';
import * as sleepcycle from './lib/sleepcycle.js';
import * as plugins from './lib/plugins.js';
import * as decks from './lib/decks.js';
import * as mcp from './lib/mcp.js';
import * as vault from './lib/vault.js';
import * as backup from './lib/backup.js';
import * as discord from './lib/discord.js';
import * as brain from './lib/brain.js';
import * as intel from './lib/intel.js';
import * as jobs from './lib/jobs.js';
import * as uploads from './lib/uploads.js';
import * as indexer from './lib/indexer.js';
import * as radar from './lib/radar.js';
import * as preview from './lib/preview.js';
import * as skillstore from './lib/skillstore.js';
import * as providers from './lib/providers.js';
import * as sessions from './lib/sessions.js';
import * as hooks from './lib/hooks.js';
import * as telemetry from './lib/telemetry.js';
import * as projectctx from './lib/projectctx.js';
import * as runtime from './lib/runtime.js';
import * as connect from './lib/connect.js';
import * as delegate from './lib/delegate.js';
import * as workprofile from './lib/workprofile.js';
import * as apps from './lib/apps.js';
import * as pipeline from './lib/pipeline.js';
import * as accounts from './lib/accounts.js';
import * as watch from './lib/watch.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const clients = new Set();

function broadcast(event, data) {
  for (const res of clients) sse(res, event, data);
}
scheduler.setNotifier(broadcast);

// Phase 3: live Semantic Event Bus → SSE clients (Action Center updates instantly)
eventbus.on((ev) => {
  try {
    broadcast('bus', ev);
    if (ev.severity === 'error' || ev.severity === 'intent' || ev.type === 'briefing.ready') {
      broadcast('intent', { id: ev.id, type: ev.type, severity: ev.severity, ts: ev.ts });
    }
    if (ev.type === 'briefing.ready') broadcast('briefing', { ts: ev.ts });
  } catch {}
});


function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function fail(res, e) {
  json(res, 200, { ok: false, error: String(e?.message || e) });
}

async function body(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function rawBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('file too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function streamHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (urlPath.startsWith('/shots/')) {
    const shot = path.join(DATA, 'shots', path.basename(rel));
    if (fs.existsSync(shot)) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      fs.createReadStream(shot).pipe(res);
      return;
    }
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function doctor() {
  const checks = [];
  const s = settings();
  const push = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

  push('Node runtime', Number(process.versions.node.split('.')[0]) >= 20, `v${process.versions.node}`, 'Install Node 20+');
  push(
    'Ollama service',
    false,
    s.provider === 'ollama' ? s.ollamaUrl : 'not the active provider',
    'Start Ollama, or switch to an API provider in Settings',
  );
  push('Ollama binary', Boolean(ollamaBin()), ollamaBin() || 'not found', 'Download from ollama.com/download');
  push('Chrome / Edge', Boolean(chromeBin()), chromeBin() || 'not found', 'Install Chrome');
  push('Bun (fast scripts)', Boolean(runtime.detect().bun), runtime.detect().bun || 'not installed — node is used instead', 'winget install Oven-sh.Bun');
  push('Google account', google.isConnected(), s.google.email || 'not connected', 'Google app → Connect');
  push('Kaggle API key', kaggle.isConfigured(), s.kaggle.username || 'not set', 'Settings → Kaggle');
  push('Model selected', Boolean(s.provider === 'openai' ? s.openai.apiKey : s.model), s.provider === 'openai' ? s.openai.model : s.model, 'Settings → Model');
  push('Workspace writable', (() => {
    try {
      ensureDir(WORKSPACE);
      fs.writeFileSync(path.join(WORKSPACE, '.probe'), 'ok');
      fs.unlinkSync(path.join(WORKSPACE, '.probe'));
      return true;
    } catch {
      return false;
    }
  })(), WORKSPACE);
  push('Skills installed', skills.list().length > 0, `${skills.list().length} skill(s)`);
  return checks;
}

async function state() {
  const models = await llm.listModels();
  const br = await browser.browserStatus();
  return {
    ok: true,
    version: PKG.version,
    platform: PLATFORM,
    port: PORT,
    settings: publicSettings(),
    models,
    modelLabel: llm.currentModelLabel(),
    modelInfo: llm.providerInfo(),
    providers: providers.list(),
    activeProviderId: providers.activeId(),
    skills: skills.list(),
    roles: Object.entries(roles()).map(([id, r]) => ({ id, name: r.name, emoji: r.emoji, tools: r.tools })),
    tasks: scheduler.list(),
    memoryCount: memory.all().length,
    googleConnected: google.isConnected(),
    kaggleConfigured: kaggle.isConfigured(),
    browser: br,
    policy: policy.describe(),
    mcp: mcp.status(),
    vault: vault.status(),
    discord: discord.status(),
    brain: brain.stats(),
    workspace: WORKSPACE,
    project: path.dirname(ROOT),
    jobs: { running: jobs.runningCount() },
    tools: Object.keys(TOOLS),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/api/events')) {
      streamHeaders(res);
      clients.add(res);
      sse(res, 'hello', { at: Date.now() });
      const hb = setInterval(() => sse(res, 'ping', { at: Date.now() }), 25000);
      req.on('close', () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return;
    }

    if (!p.startsWith('/api/') && !p.startsWith('/oauth/')) return serveStatic(req, res);

    /* ------------------------------- oauth ------------------------------- */
    if (p === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<body style="font:15px system-ui;background:#0b0d12;color:#fca5a5;padding:40px">Google returned: ${err}</body>`);
        return;
      }
      try {
        const r = await google.exchangeCode(code);
        res.end(`<body style="font:15px system-ui;background:#0b0d12;color:#86efac;padding:40px">
          Connected${r.email ? ` as <b>${r.email}</b>` : ''}. You can close this tab and return to Nexus.</body>
          <script>setTimeout(()=>window.close(),1400)</script>`);
        broadcast('google', { connected: true, email: r.email });
      } catch (e) {
        res.end(`<body style="font:15px system-ui;background:#0b0d12;color:#fca5a5;padding:40px">${e.message}</body>`);
      }
      return;
    }

    /* --------------------------------- vault -------------------------------- */
    if (p === '/api/vault') {
      if (req.method === 'GET') {
        const st = vault.status();
        return json(res, 200, { ok: true, ...st, items: st.unlocked ? vault.list() : [] });
      }
      const b = await body(req);
      try {
        switch (b.action) {
          case 'create':
            return json(res, 200, { ok: true, ...vault.create(b.passphrase), items: [] });
          case 'unlock':
            return json(res, 200, { ok: true, ...vault.unlock(b.passphrase), items: vault.list() });
          case 'lock':
            vault.lock();
            return json(res, 200, { ok: true, ...vault.status(), items: [] });
          case 'add':
            return json(res, 200, { ok: true, entry: vault.add(b.entry), items: vault.list() });
          case 'update':
            return json(res, 200, { ok: true, entry: vault.update(b.id, b.entry), items: vault.list() });
          case 'delete':
            return json(res, 200, { ok: true, ...vault.remove(b.id), items: vault.list() });
          case 'reveal':
            policy.audit({ tool: 'vault.reveal', summary: b.id, decision: 'allow', reason: 'user reveal', risk: 'read' });
            return json(res, 200, { ok: true, entry: vault.reveal(b.id) });
          case 'generate':
            return json(res, 200, { ok: true, password: vault.generate(b.options || {}) });
          case 'export':
            return json(res, 200, { ok: true, bundle: vault.exportEncrypted() });
          case 'health':
            return json(res, 200, { ok: true, ...vault.healthCheck(), ...vault.status() });
          default:
            return json(res, 200, { ok: false, error: `unknown vault action: ${b.action}` });
        }
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- backup -------------------------------- */
    if (p === '/api/backup') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          vault: vault.status(),
          googleConnected: google.isConnected(),
          local: backup.listLocal(),
          drive: await backup.listDriveBackups().catch((e) => ({ connected: google.isConnected(), files: [], error: e.message })),
        });
      }
      try {
        const b = await body(req);
        return json(res, 200, await backup.runBackup({ upload: b.upload !== false, note: b.note || '' }));
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- discord ------------------------------- */
    if (p === '/api/discord') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...discord.status() });
      const b = await body(req);
      try {
        if (b.action === 'save') {
          saveSettings(unmaskSettings({ discord: b.discord || {} }));
          return json(res, 200, { ok: true, ...discord.status() });
        }
        if (b.action === 'start') return json(res, 200, { ok: true, ...(await discord.start()) });
        if (b.action === 'stop') return json(res, 200, { ok: true, ...(await discord.stop()) });
        if (b.action === 'test') return json(res, 200, await discord.test());
        if (b.action === 'say') return json(res, 200, { ok: true, sent: await discord.sendMessage(b.channelId, b.content) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- brain -------------------------------- */
    if (p === '/api/brain') {
      if (req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return json(res, 200, {
          ok: true,
          stats: brain.stats(),
          profile: brain.profile(),
          digest: brain.digest(),
          items: q ? brain.search(q, 30) : [...(await import('./lib/util.js')).readJsonl(path.join(DATA, 'brain.jsonl'))].slice(-40).reverse(),
        });
      }
      const b = await body(req);
      try {
        if (b.action === 'add') return json(res, 200, { ok: true, entry: brain.add(b.entry || b) });
        if (b.action === 'update') return json(res, 200, { ok: true, entry: brain.update(b.id, b.entry || {}) });
        if (b.action === 'delete') return json(res, 200, { ok: true, ...brain.remove(b.id) });
        if (b.action === 'search') return json(res, 200, { ok: true, items: brain.search(b.q || '', b.limit || 20) });
        if (b.action === 'sync') return json(res, 200, { ok: true, report: brain.syncAgents(), stats: brain.stats() });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- intel -------------------------------- */
    if (p === '/api/intel') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          plan: intel.plan({ hoursPerWeek: Number(url.searchParams.get('hours')) || 10 }),
          rules: intel.PLATFORM_RULES,
          githubConfigured: Boolean(settings().github?.token),
        });
      }
      const b = await body(req);
      try {
        if (b.action === 'opportunities') {
          return json(res, 200, { ok: true, opportunities: await intel.opportunities(b) });
        }
        if (b.action === 'rules') return json(res, 200, { ok: true, ...intel.rulesFor(b.platform) });
        if (b.action === 'save_plan') {
          const saved = intel.rememberPlan(intel.plan(b));
          return json(res, 200, { ok: true, saved: saved.map((s) => s.title) });
        }
        if (b.action === 'github') {
          if (b.kind === 'prs') return json(res, 200, { ok: true, pulls: await intel.githubPRs(b.repo, { state: b.state || 'open' }) });
          if (b.kind === 'repo') return json(res, 200, { ok: true, repo: await intel.githubRepo(b.repo) });
          return json(res, 200, { ok: true, issues: await intel.githubIssues(b.query || 'bounty', { labels: b.labels }) });
        }
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* ---------------------------------- jobs --------------------------------- */
    if (p === '/api/jobs') {
      if (req.method === 'GET') return json(res, 200, { ok: true, jobs: jobs.list(), running: jobs.runningCount() });
      try {
        const b = await body(req);
        if (b.action === 'start') return json(res, 200, { ok: true, job: jobs.run(b) });
        if (b.action === 'kill') return json(res, 200, { ok: true, ...jobs.kill(b.id) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p.startsWith('/api/jobs/')) {
      try {
        const id = p.slice('/api/jobs/'.length);
        return json(res, 200, { ok: true, ...jobs.get(id, Number(url.searchParams.get('since')) || 0) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- artifacts ------------------------------ */
    if (req.method === 'GET' && p === '/api/artifacts') {
      const roots = [WORKSPACE, path.dirname(ROOT)];
      const out = [];
      for (const root of roots) {
        try {
          for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const full = path.join(root, e.name);
            const st = fs.statSync(full);
            if (st.size > 60 * 1024 * 1024) continue;
            const ext = path.extname(e.name).toLowerCase();
            out.push({
              name: e.name,
              path: full,
              root,
              bytes: st.size,
              at: st.mtime.toISOString(),
              kind: ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
                ? 'image'
                : ['.pptx', '.potx', '.docx', '.xlsx', '.pdf'].includes(ext)
                  ? 'office'
                  : ['.py', '.js', '.json', '.md', '.txt', '.csv', '.log', '.jsonl'].includes(ext)
                    ? 'text'
                    : 'other',
            });
          }
        } catch {}
      }
      return json(res, 200, { ok: true, items: out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 120) });
    }
    if (req.method === 'GET' && p === '/api/artifact') {
      const target = path.resolve(url.searchParams.get('path') || '');
      const allowed = [WORKSPACE, path.dirname(ROOT)].some((root) => target.startsWith(root));
      if (!allowed || !fs.existsSync(target)) return json(res, 404, { ok: false, error: 'not allowed' });
      const st = fs.statSync(target);
      if (st.size > 60 * 1024 * 1024) return json(res, 200, { ok: false, error: 'too large to preview' });
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size });
      return fs.createReadStream(target).pipe(res);
    }

    /* -------------------------------- uploads -------------------------------- */
    if (req.method === 'POST' && p === '/api/upload') {
      try {
        const name = url.searchParams.get('name') || 'file';
        const buf = await rawBody(req);
        const saved = await uploads.saveUpload({ name, buffer: buf });
        return json(res, 200, { ok: true, file: saved });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p === '/api/uploads') return json(res, 200, { ok: true, items: uploads.listUploads() });

    /* --------------------------------- index --------------------------------- */
    if (p === '/api/index') {
      if (req.method === 'GET') return json(res, 200, { ok: true, stats: indexer.stats() });
      const b = await body(req);
      try {
        if (b.action === 'scan') return json(res, 200, { ok: true, ...indexer.startScan({ roots: b.roots, max: b.max }) });
        if (b.action === 'search') return json(res, 200, { ok: true, items: indexer.search(b.q, b.limit || 60) });
        if (b.action === 'suggestions') return json(res, 200, { ok: true, items: indexer.suggestions() });
        if (b.action === 'collections') return json(res, 200, { ok: true, items: indexer.collections() });
        return json(res, 200, { ok: true, status: indexer.status(), stats: indexer.stats() });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* ------------------------------- file ops -------------------------------- */
    if (req.method === 'POST' && p.startsWith('/api/fs/')) {
      const op = p.slice('/api/fs/'.length);
      const b = await body(req);
      try {
        if (op === 'list') {
          const { files: fstools } = await import('./lib/tools.js');
          return json(res, 200, { ok: true, ...fstools.list(b.dir || '.') });
        }
        if (op === 'read') {
          const { files: fstools } = await import('./lib/tools.js');
          return json(res, 200, { ok: true, ...fstools.read(b.path, 20000) });
        }
        if (op === 'trash') {
          // Recycle Bin, never a permanent delete.
          const target = path.resolve(b.path);
          const { runShell } = await import('./lib/tools.js');
          const cmd = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${target.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
          const r = await runShell(cmd, {});
          policy.audit({ tool: 'fs.trash', summary: target, decision: r.code === 0 ? 'allow' : 'error', reason: 'recycle bin', risk: 'destructive' });
          return json(res, 200, { ok: r.code === 0, output: r.stdout, error: r.stderr });
        }
        if (op === 'mkdir') {
          fs.mkdirSync(path.resolve(b.path), { recursive: true });
          return json(res, 200, { ok: true });
        }
        if (op === 'rename') {
          fs.renameSync(path.resolve(b.path), path.resolve(b.to));
          return json(res, 200, { ok: true });
        }
        if (op === 'zip' || op === 'unzip') {
          const { runShell } = await import('./lib/tools.js');
          const cmd =
            op === 'zip'
              ? `Compress-Archive -LiteralPath '${b.path}' -DestinationPath '${b.to}' -Force`
              : `Expand-Archive -LiteralPath '${b.path}' -DestinationPath '${b.to}' -Force`;
          const r = await runShell(cmd, {});
          return json(res, 200, { ok: r.code === 0, output: r.stdout, error: r.stderr });
        }
        return json(res, 200, { ok: false, error: 'unknown file op' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- radar --------------------------------- */
    if (p === '/api/radar') {
      if (req.method === 'GET') {
        const items = brain.search('opportunity competition deadline', 20).filter((i) => i.tags?.includes('radar') || i.kind === 'competition');
        return json(res, 200, {
          ok: true,
          sources: radar.SOURCES,
          items: items.map((i) => ({ id: i.id, title: i.title, body: i.body, meta: i.meta, tags: i.tags })),
        });
      }
      try {
        const b = await body(req);
        if (b.action === 'dive') return json(res, 200, { ok: true, ...(await radar.dive(b.url)) });
        const result = await radar.scan({ remember: b.remember !== false });
        return json(res, 200, { ok: true, ...result, digest: radar.digestText(result) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- preview -------------------------------- */
    if (req.method === 'GET' && p === '/api/preview') {
      try {
        return json(res, 200, await preview.preview(url.searchParams.get('path') || ''));
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p === '/api/thumb') {
      const key = String(url.searchParams.get('key') || '').replace(/[^a-f0-9]/gi, '');
      const file = path.basename(String(url.searchParams.get('file') || ''));
      const target = path.join(DATA, 'thumbs', key, file);
      if (!target.startsWith(path.join(DATA, 'thumbs')) || !fs.existsSync(target)) return json(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=300' });
      return fs.createReadStream(target).pipe(res);
    }
    if (req.method === 'POST' && p === '/api/verify') {
      const b = await body(req);
      const claims = preview.verifyClaims(b.text || '');
      const stat = b.path ? preview.statOf(path.resolve(b.path)) : null;
      return json(res, 200, { ok: true, ...claims, stat });
    }
    if (req.method === 'POST' && p === '/api/reveal') {
      const b = await body(req);
      const target = path.resolve(b.path || '');
      if (!fs.existsSync(target)) return json(res, 200, { ok: false, error: 'path does not exist' });
      const { runShell } = await import('./lib/tools.js');
      await runShell(`explorer.exe /select,"${target}"`, {});
      return json(res, 200, { ok: true });
    }

    /* -------------------------------- providers ------------------------------ */
    if (p === '/api/providers') {
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, presets: providers.PRESETS, profiles: providers.list(), activeId: providers.activeId() });
      }
      const b = await body(req);
      try {
        if (b.action === 'add' || b.action === 'update') return json(res, 200, { ok: true, profile: providers.upsert(b.profile || b), profiles: providers.list() });
        if (b.action === 'remove') return json(res, 200, { ok: true, profiles: providers.remove(b.id) });
        if (b.action === 'activate') return json(res, 200, { ok: true, profile: providers.activate(b.id), profiles: providers.list() });
        if (b.action === 'test') return json(res, 200, await providers.testProfile(b.id));
        if (b.action === 'discover') return json(res, 200, { ok: true, ...(await providers.discoverFreeModels({ onlyFree: b.onlyFree !== false })) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- sessions ------------------------------- */
    if (p === '/api/sessions') {
      if (req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return json(res, 200, { ok: true, items: sessions.list(), search: q ? sessions.search(q) : undefined });
      }
      const b = await body(req);
      try {
        if (b.action === 'create') return json(res, 200, { ok: true, session: sessions.create(b) });
        if (b.action === 'save') return json(res, 200, { ok: true, ...sessions.save(b) });
        if (b.action === 'rename') return json(res, 200, { ok: true, session: sessions.rename(b.id, b.title) });
        if (b.action === 'delete') return json(res, 200, { ok: true, ...sessions.remove(b.id) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p.startsWith('/api/sessions/')) {
      try {
        return json(res, 200, { ok: true, session: sessions.load(p.slice('/api/sessions/'.length)) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- hooks --------------------------------- */
    if (p === '/api/hooks') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...hooks.get() });
      const b = await body(req);
      try {
        return json(res, 200, { ok: true, ...hooks.set(b) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- usage ---------------------------------- */
    if (p === '/api/usage') {
      if (req.method === 'GET') return json(res, 200, { ok: true, totals: telemetry.readTotals(), active: providers.activeProfile()?.model || settings().model });
      return json(res, 200, { ok: true, totals: telemetry.resetTotals() });
    }

    /* ------------------------------- autostart ------------------------------- */
    if (p === '/api/autostart') {
      // Startup folder, not schtasks: ONLOGON needs elevation, a .lnk in the user's Startup folder does not.
      const startupDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const lnk = path.join(startupDir, 'Nexus Agent OS.lnk');
      const startCmd = path.join(ROOT, 'start.cmd');
      const run = (cmd) => new Promise((resolve) => exec(cmd, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })));
      const state = () => ({ enabled: fs.existsSync(lnk), lnk, startupDir });

      if (req.method === 'GET') return json(res, 200, { ok: true, ...state(), startCmd });
      const b = await body(req);
      if (b.action === 'enable') {
        try {
          fs.mkdirSync(startupDir, { recursive: true });
          const ps = `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut('${lnk}'); $s.TargetPath = '${startCmd}'; $s.WorkingDirectory = '${ROOT}'; $s.Description = 'Nexus - local agent OS'; $s.Save()`;
          const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`);
          return json(res, 200, { ...r, ...state() });
        } catch (e) {
          return fail(res, e);
        }
      }
      if (b.action === 'disable') {
        try {
          if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
          return json(res, 200, { ok: true, ...state() });
        } catch (e) {
          return fail(res, e);
        }
      }
      return json(res, 200, { ok: false, error: 'unknown action' });
    }

    /* --------------------------------- project -------------------------------- */
    if (p === '/api/project') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...projectctx.load() });
      const b = await body(req);
      try {
        if (b.action === 'remember') return json(res, 200, projectctx.remember(b.dir, b.line));
        const loaded = projectctx.setDir(b.dir);
        return json(res, 200, { ok: true, ...loaded });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- runtime -------------------------------- */
    if (p === '/api/runtime') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...runtime.detect({ fresh: true }) });
      const b = await body(req);
      try {
        if (b.action === 'bench') return json(res, 200, { ok: true, ...(await runtime.bench({ runs: b.runs || 3 })) });
        if (b.action === 'run') return json(res, 200, { ok: true, ...(await runtime.runScript(b)) });
        return json(res, 200, { ok: true, ...runtime.detect({ fresh: true }) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- handoff -------------------------------- */
    if (req.method === 'POST' && p === '/api/handoff') {
      try {
        const b = await body(req);
        const note = String(b.note || '').trim();
        if (!note) return json(res, 200, { ok: false, error: 'handoff needs a note' });
        const wrote = projectctx.remember(b.dir, note);
        const fresh = sessions.create({ title: (b.title || 'after handoff').slice(0, 70) });
        return json(res, 200, { ok: true, wrote, session: fresh });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- update -------------------------------- */
    if (p === '/api/update') {
      const current = PKG.version;
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, current, updateUrl: settings().updateUrl || '', script: path.join(ROOT, 'update.cmd') });
      }
      const b = await body(req);
      try {
        const feed = String(b.url || settings().updateUrl || '');
        if (!feed) return json(res, 200, { ok: false, error: 'no update feed configured (Settings → updateUrl). Auto-applying an unverified zip is how installs get bricked.' });
        if (b.action === 'check') {
          const res2 = await fetchWithTimeout(feed, {}, 20000);
          if (!res2.ok) throw new Error(`feed HTTP ${res2.status}`);
          const latest = (await res2.text()).trim().split('\n').pop().trim();
          return json(res, 200, { ok: true, current, latest, newer: latest !== current });
        }
        return json(res, 200, { ok: false, error: 'run update.cmd for the actual install — it keeps data/ and backs up lib/ first' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- connect -------------------------------- */
    if (p === '/api/connect') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...connect.status() });
      const b = await body(req);
      try {
        if (b.action === 'kaggle-detect') return json(res, 200, await connect.detectKaggle());
        if (b.action === 'kaggle-find') return json(res, 200, { ok: true, ...(connect.findKaggleJson() || {}) });
        if (b.action === 'github') return json(res, 200, await connect.saveGithub(b.token));
        if (b.action === 'discord') return json(res, 200, await connect.saveDiscord(b.token));
        if (b.action === 'telegram') return json(res, 200, await connect.saveTelegram(b.token, b.chatId));
        if (b.action === 'provider') return json(res, 200, await connect.saveProviderKey(b));
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- accounts -------------------------------- */
    if (p === '/api/accounts') {
      if (req.method === 'GET') return json(res, 200, { ok: true, items: accounts.list(), emails: accounts.emails(), watches: watch.summary() });
      const b = await body(req);
      try {
        if (b.action === 'upsert') return json(res, 200, { ok: true, account: accounts.upsert(b.account || b), items: accounts.list() });
        if (b.action === 'remove') return json(res, 200, { ok: true, items: accounts.remove(b.id) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- watch ---------------------------------- */
    if (p === '/api/watch') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...watch.summary() });
      const b = await body(req);
      try {
        if (b.action === 'add') {
          const added = watch.add(b);
          // Seed every registry account that names a watch URL.
          return json(res, 200, { ok: true, watch: added });
        }
        if (b.action === 'seed') {
          const created = [];
          for (const acc of accounts.list()) {
            if (!acc.watch) continue;
            try {
              created.push(watch.add({ url: acc.watch, label: `${acc.service} — listings`, id: `w_${acc.id}`, note: acc.notes || '' }));
            } catch {}
          }
          return json(res, 200, { ok: true, created: created.length, ...watch.summary() });
        }
        if (b.action === 'check') return json(res, 200, { ok: true, ...(await watch.check(b.id)) });
        if (b.action === 'checkall') return json(res, 200, { ok: true, ...(await watch.checkAll({ onlyChanged: false })) });
        if (b.action === 'remove') return json(res, 200, { ok: true, ...watch.remove(b.id) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- delegate -------------------------------- */
    if (p === '/api/delegate') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...delegate.status() });
      const b = await body(req);
      try {
        if (b.action === 'set') return json(res, 200, { ok: true, clis: delegate.setClis(b.clis), ...delegate.status() });
        return json(res, 200, { ok: true, ...(await delegate.run(b)) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* ---------------------------------- work --------------------------------- */
    if (p === '/api/work') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...workprofile.profile() });
      const b = await body(req);
      try {
        if (b.action === 'derive') return json(res, 200, { ok: true, ...workprofile.deriveSkills({ enable: b.enable !== false }), profile: workprofile.profile() });
        if (b.action === 'mirror') return json(res, 200, { ok: true, ...workprofile.mirrorAutomation(b.id, { when: b.when }), profile: workprofile.profile() });
        if (b.action === 'unmirror') return json(res, 200, { ok: true, ...workprofile.unmatchMirror(b.taskId), profile: workprofile.profile() });
        return json(res, 200, { ok: true, profile: workprofile.profile() });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* ---------------------------------- apps --------------------------------- */
    if (p === '/api/apps') {
      if (req.method === 'GET') {
        try {
          const list = await apps.listApps({ fresh: url.searchParams.get('fresh') === '1' });
          return json(res, 200, { ok: true, count: list.length, apps: list.slice(0, 400) });
        } catch (e) {
          return fail(res, e);
        }
      }
      const b = await body(req);
      try {
        if (b.action === 'launch') return json(res, 200, await apps.launch(b));
        if (b.action === 'programs') return json(res, 200, { ok: true, programs: await apps.installedPrograms(), disks: await apps.disks() });
        if (b.action === 'open-uninstaller') return json(res, 200, await apps.openUninstaller(b));
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* -------------------------------- pipeline ------------------------------- */
    if (p === '/api/pipeline') {
      if (req.method === 'GET') return json(res, 200, { ok: true, stages: pipeline.STAGES, humanFrom: pipeline.HUMAN_FROM, ...pipeline.summary() });
      const b = await body(req);
      try {
        if (b.action === 'add') return json(res, 200, { ok: true, ...pipeline.add(b), ...pipeline.summary() });
        if (b.action === 'advance') return json(res, 200, { ok: true, ...pipeline.advance(b.id, b.to, { actor: b.actor || 'human', note: b.note }), ...pipeline.summary() });
        if (b.action === 'update') return json(res, 200, { ok: true, item: pipeline.update(b.id, b), ...pipeline.summary() });
        if (b.action === 'remove') return json(res, 200, { ok: true, ...pipeline.remove(b.id), ...pipeline.summary() });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }


    /* --------------------- Phase 2: event bus, workspaces, briefing --------------------- */
    if (p === '/api/action-center') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          cards: eventbus.intentCards({ limit: 16 }),
          recent: eventbus.recent({ limit: 30 }),
        });
      }
      const b = await body(req);
      if (b.action === 'clear') {
        eventbus.clear();
        return json(res, 200, { ok: true });
      }
      if (b.action === 'emit') {
        eventbus.emit(b.type || 'custom', b.payload || {}, { severity: b.severity || 'info', source: b.source || 'ui' });
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: false, error: 'unknown action' });
    }

    if (p === '/api/workspaces') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...workspaces.list() });
      const b = await body(req);
      try {
        if (b.action === 'activate') return json(res, 200, { ok: true, active: workspaces.setActive(b.id) });
        if (b.action === 'upsert') return json(res, 200, { ok: true, workspace: workspaces.upsert(b) });
        if (b.action === 'remove') return json(res, 200, workspaces.remove(b.id));
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    if (p === '/api/recipes') {
      recipes.seedExampleRecipes();
      if (req.method === 'GET') return json(res, 200, { ok: true, recipes: recipes.listRecipes() });
      const b = await body(req);
      try {
        if (b.action === 'get') return json(res, 200, { ok: true, recipe: recipes.getRecipe(b.id) });
        if (b.action === 'save') return json(res, 200, { ok: true, recipe: recipes.saveRecipe(b) });
        if (b.action === 'delete') return json(res, 200, recipes.deleteRecipe(b.id));
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    if (p === '/api/plugins') {
      if (req.method === 'GET') return json(res, 200, { ok: true, plugins: plugins.list() });
      const b = await body(req);
      try {
        if (b.action === 'reload') return json(res, 200, { ok: true, plugins: await plugins.reload() });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }

    if (p === '/api/sleep-cycle') {
      if (req.method === 'POST') {
        const b = await body(req).catch(() => ({}));
        try {
          const r = await sleepcycle.runSleepCycle({ force: !!b.force, reason: b.reason || 'manual' });
          return json(res, 200, r);
        } catch (e) {
          return fail(res, e);
        }
      }
      return json(res, 200, { ok: true, info: 'POST { force?: true } to run cognitive sleep now' });
    }

    if (req.method === 'GET' && p === '/api/briefing') {
      const latest = path.join(DATA, 'briefings', 'latest.md');
      let text = '';
      try { text = fs.readFileSync(latest, 'utf8'); } catch {}
      return json(res, 200, { ok: true, briefing: text, has: !!text });
    }

    if (req.method === 'GET' && p.startsWith('/micro-app/')) {
      const id = p.slice('/micro-app/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(DATA, 'micro-apps', id + '.html');
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
      return;
    }

    if (req.method === 'GET' && p === '/api/state') return json(res, 200, await state());

    /* --------------------------- policy & safety --------------------------- */
    if (req.method === 'GET' && p === '/api/policy') return json(res, 200, { ok: true, ...policy.describe() });
    if (req.method === 'POST' && p === '/api/policy') {
      const b = await body(req);
      if (b.mode) {
        if (!policy.MODES[b.mode]) return json(res, 200, { ok: false, error: 'unknown mode' });
        policy.updatePolicy({ mode: b.mode });
        broadcast('policy', { mode: b.mode });
      }
      if (b.budgets) policy.updatePolicy(b.budgets);
      return json(res, 200, { ok: true, ...policy.describe() });
    }
    if (req.method === 'POST' && p === '/api/policy/rule') {
      const { action, match, decision } = await body(req);
      const rules = action === 'remove' ? policy.removeRule(match) : policy.addRule(match, decision || 'allow');
      return json(res, 200, { ok: true, rules });
    }
    if (req.method === 'GET' && p === '/api/approvals') return json(res, 200, { ok: true, pending: policy.pendingApprovals() });
    if (req.method === 'POST' && p === '/api/approvals') {
      const { id, decision, scope } = await body(req);
      try {
        const r = policy.resolveApproval(id, decision, scope || 'once');
        return json(res, 200, r);
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p === '/api/audit') {
      return json(res, 200, { ok: true, entries: policy.readAudit(Number(url.searchParams.get('limit')) || 200) });
    }
    if (req.method === 'GET' && p === '/api/checkpoints') return json(res, 200, { ok: true, items: policy.listCheckpoints() });
    if (req.method === 'POST' && p === '/api/checkpoints/restore') {
      const { backup } = await body(req);
      try {
        return json(res, 200, { ok: true, ...policy.restoreCheckpoint(backup) });
      } catch (e) {
        return fail(res, e);
      }
    }

    /* --------------------------------- mcp --------------------------------- */
    if (req.method === 'GET' && p === '/api/mcp') return json(res, 200, { ok: true, servers: mcp.status(), catalog: mcp.catalog() });
    if (req.method === 'POST' && p === '/api/mcp') {
      const b = await body(req);
      try {
        if (b.action === 'add') {
          mcp.addServer(b.server);
          return json(res, 200, { ok: true, servers: await mcp.syncServers() });
        }
        if (b.action === 'install') {
          const r = await mcp.installPreset(b.id, { args: b.args || [], cwd: b.cwd });
          return json(res, 200, { ok: true, ...r, servers: mcp.status() });
        }
        if (b.action === 'remove') {
          mcp.removeServer(b.name);
          return json(res, 200, { ok: true, servers: mcp.status() });
        }
        return json(res, 200, { ok: true, servers: await mcp.syncServers() });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'GET' && p === '/api/doctor') {
      const checks = doctor();
      const models = await llm.listModels();
      const ollamaIdx = checks.findIndex((c) => c.name === 'Ollama service');
      checks[ollamaIdx].ok = !models.error;
      checks[ollamaIdx].detail = models.error ? models.error : `${models.models.length} model(s): ${models.models.slice(0, 6).join(', ')}`;
      if (!models.error && !models.models.length) {
        checks[ollamaIdx].ok = false;
        checks[ollamaIdx].fix = 'Run: ollama pull qwen2.5:7b';
      }
      return json(res, 200, { ok: true, checks, models });
    }
    if (req.method === 'GET' && p === '/api/models') return json(res, 200, await llm.listModels());

    if (req.method === 'POST' && p === '/api/settings') {
      const patch = await body(req);
      saveSettings(unmaskSettings(patch));
      return json(res, 200, { ok: true, settings: publicSettings() });
    }

    if (req.method === 'POST' && p === '/api/chat') {
      const b = await body(req);
      const { role = 'core', mode = 'agent', policyMode, attachments } = b;
      let { input, messages } = b;
      // Stop button: when the browser aborts the fetch, cancel the run instead of burning the
      // free-tier model to completion with nobody listening.
      const ac = new AbortController();
      req.on('close', () => { if (!res.writableEnded) ac.abort(); });
      // Attachments become a text block on the user turn, so the model gets real file contents and
      // real paths instead of just names it has to guess about.
      if (Array.isArray(attachments) && attachments.length) {
        const block = uploads.attachmentBlock(attachments);
        if (Array.isArray(messages) && messages.length) {
          const copy = [...messages];
          const last = copy[copy.length - 1];
          if (last?.role === 'user') copy[copy.length - 1] = { role: 'user', content: `${block}\n\n${last.content || ''}` };
          messages = copy;
          input = `${block}\n\n${input || ''}`;
        } else {
          input = `${block}\n\n${input || 'See attached files.'}`;
        }
      }
      if (!input && !messages?.length) return json(res, 400, { ok: false, error: 'empty input' });
      streamHeaders(res);
      const emit = (type, payload) => {
        if (res.destroyed || res.writableEnded) return;
        try { sse(res, type, payload); } catch {}
      };
      try {
        if (mode === 'chat') {
          let buf = '';
          const stream = llm.chatStream(
            [
              { role: 'system', content: `You are Nexus, a concise local assistant. Today is ${new Date().toDateString()}.` },
              ...(messages?.length ? messages : [{ role: 'user', content: input }]),
            ],
            { signal: ac.signal, onProvider: info => emit('provider', info) },
          );
          for await (const piece of stream) {
            buf += piece;
            emit('delta', { text: piece });
          }
          emit('answer', { text: buf.trim() });
        } else {
          const result = await runAgent({ role, input, messages, emit, policyMode, signal: ac.signal });
          if (result?.answer) {
            brain.recordSession({ role, input: input || messages?.at(-1)?.content, answer: result.answer, tools: (result.steps || []).map((s) => s.name) });
          }
        }
      } catch (e) {
        emit('error', { message: String(e.message || e) });
      }
      // The client may be gone. Touching a destroyed response here is what used to wedge the
      // process after Stop; if nobody is listening, there is nothing left to send.
      if (res.destroyed || res.writableEnded) return;
      try { sse(res, 'done', { at: Date.now() }); res.end(); } catch {}
      return;
    }

    if (req.method === 'POST' && p === '/api/cluster') {
      const { brief, roles: rs } = await body(req);
      streamHeaders(res);
      const emit = (type, payload) => sse(res, type, payload);
      try {
        await runCluster({ brief, roles: rs, emit });
      } catch (e) {
        emit('error', { message: String(e.message || e) });
      }
      sse(res, 'done', {});
      res.end();
      return;
    }

    if (p === '/api/decks') {
      try {
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, template: decks.templatePath(), jobs: decks.recent() });
        }
        const b = await body(req);
        const action = b.action || 'status';
        if (action === 'build') return json(res, 200, { ok: true, job: decks.build(b) });
        if (action === 'status') return json(res, 200, decks.status(b.id));
        if (action === 'set-template') return json(res, 200, { ok: true, template: decks.saveTemplatePath(b.path) });
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (req.method === 'POST' && p === '/api/search') {
      const { q, max } = await body(req);
      return json(res, 200, await search(q, { max }));
    }

    if (req.method === 'POST' && p === '/api/page') {
      const { url: u } = await body(req);
      return json(res, 200, await readPage(u));
    }

    if (req.method === 'POST' && p === '/api/browser') {
      const { action, ...rest } = await body(req);
      const tool = TOOLS.browser;
      if (!['launch', 'status', 'tabs', 'open', 'snapshot', 'click', 'type', 'press', 'scroll', 'screenshot', 'close', 'new_tab', 'wait', 'activate', 'close_tab', 'mouse', 'move', 'hover', 'rightclick', 'doubleclick', 'drag', 'wheel', 'waitfor', 'fill', 'upload', 'frames', 'eval_frame', 'see', 'locate', 'click_vision', 'evaluate'].includes(action)) {
        return json(res, 200, { ok: false, error: 'unknown action' });
      }
      const r = await tool.run({ action, ...rest }, {});
      if (action === 'screenshot') return json(res, 200, { ok: true, file: r.file });
      return json(res, 200, { ok: true, action, result: r, ...(await browser.browserStatus().catch(() => ({}))) });
    }

    /* mail shortcuts used by the Gmail app */
    if (req.method === 'POST' && p === '/api/mail/search') {
      const { q } = await body(req);
      if (!google.isConnected()) return json(res, 200, { ok: false, error: 'Google is not connected yet.' });
      return json(res, 200, { ok: true, messages: await google.gmailSearch(q, 10) });
    }
    if (req.method === 'POST' && p === '/api/mail/read') {
      const { id } = await body(req);
      return json(res, 200, { ok: true, message: await google.gmailRead(id) });
    }
    if (req.method === 'POST' && p === '/api/mail/send') {
      const { to, subject, body: text } = await body(req);
      if (!google.isConnected()) return json(res, 200, { ok: false, error: 'Google is not connected yet.' });
      return json(res, 200, { ok: true, sent: await google.gmailSend({ to, subject, body: text }) });
    }

    /* file browser */
    if (req.method === 'POST' && p === '/api/fs/list') {
      const { dir } = await body(req);
      const { files: fstools } = await import('./lib/tools.js');
      return json(res, 200, { ok: true, ...fstools.list(dir || '.') });
    }
    if (req.method === 'POST' && p === '/api/fs/read') {
      const { path: target } = await body(req);
      const { files: fstools } = await import('./lib/tools.js');
      return json(res, 200, { ok: true, ...fstools.read(target, 20000) });
    }

    if (req.method === 'POST' && p === '/api/shell') {
      const { command } = await body(req);
      const r = await runShell(command, {});
      return json(res, 200, r);
    }

    if (p === '/api/tasks') {
      if (req.method === 'GET') return json(res, 200, { ok: true, tasks: scheduler.list() });
      const b = await body(req);
      try {
        if (b.action === 'delete') return json(res, 200, { ok: true, ...scheduler.remove(b.id) });
        if (b.action === 'toggle') return json(res, 200, { ok: true, task: scheduler.toggle(b.id, b.enabled) });
        if (b.action === 'run') return json(res, 200, { ok: true, ...(await scheduler.runNow(b.id)) });
        return json(res, 200, { ok: true, task: scheduler.create(b) });
      } catch (e) {
        return fail(res, e);
      }
    }

    if (p === '/api/memory') {
      if (req.method === 'GET') return json(res, 200, { ok: true, items: memory.all().slice(-200).reverse() });
      const b = await body(req);
      if (b.action === 'delete') return json(res, 200, { ok: true, ...memory.remove(b.id) });
      return json(res, 200, { ok: true, saved: memory.save(b.text, b) });
    }

    if (p === '/api/skills') {
      if (req.method === 'GET') return json(res, 200, { ok: true, skills: skills.list() });
      const b = await body(req);
      if (b.action === 'toggle') return json(res, 200, { ok: true, skills: skills.toggle(b.id, b.on) });
      if (b.action === 'read') return json(res, 200, { ok: true, skill: skills.load(b.id) });
      if (b.action === 'discover') return json(res, 200, { ok: true, items: await skillstore.discover(b.q) });
      if (b.action === 'fetch') {
        try {
          return json(res, 200, await skillstore.fetchSkill(b.url));
        } catch (e) {
          return fail(res, e);
        }
      }
      if (b.action === 'install_url') {
        try {
          return json(res, 200, await skillstore.install({ url: b.url, id: b.id, enable: Boolean(b.enable) }));
        } catch (e) {
          return fail(res, e);
        }
      }
      if (b.action === 'enable_all') return json(res, 200, { ok: true, skills: skillstore.enableAll() });
      if (b.action === 'install') {
        const dir = path.join(SKILLS, String(b.id || 'skill').replace(/[^a-z0-9_-]/gi, '-').toLowerCase());
        ensureDir(dir);
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: ${b.name || b.id}\ndescription: ${b.description || 'Custom skill'}\n---\n\n${b.body || '# ' + (b.name || b.id) + '\n\nWrite the instructions here.'}\n`,
          'utf8',
        );
        return json(res, 200, { ok: true, skills: skills.list() });
      }
      if (b.action === 'delete') {
        const dir = path.join(SKILLS, String(b.id));
        if (dir.startsWith(SKILLS) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        return json(res, 200, { ok: true, skills: skills.list() });
      }
    }

    if (req.method === 'POST' && p === '/api/google/auth') {
      const b = await body(req);
      if (b.label) saveSettings({ google: { pendingLabel: String(b.label).slice(0, 40) } });
      return json(res, 200, { ok: true, url: google.authUrl() });
    }
    if (p === '/api/google/accounts') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          activeId: google.activeAccount()?.id || '',
          accounts: google.accounts().map((a) => ({ id: a.id, label: a.label, email: a.email })),
        });
      }
      const b = await body(req);
      try {
        if (b.action === 'switch') return json(res, 200, google.switchAccount(b.id));
        if (b.action === 'remove') return json(res, 200, google.removeAccount(b.id));
        if (b.action === 'rename') return json(res, 200, google.renameAccount(b.id, b.label));
        return json(res, 200, { ok: false, error: 'unknown action' });
      } catch (e) {
        return fail(res, e);
      }
    }
    if (req.method === 'POST' && p === '/api/google/disconnect') {
      await google.disconnect();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/google/test') {
      const r = await google.gmailSearch('newer_than:2d', 1).catch((e) => ({ error: e.message }));
      return json(res, 200, { ok: !r.error, sample: r });
    }

    if (req.method === 'POST' && p === '/api/kaggle/test') {
      const r = await kaggle.whoAmI();
      if (r.ok) kaggle.writeKaggleJson();
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/kaggle/list') {
      const { action = 'kernels', search: q, ref } = await body(req);
      const map = {
        kernels: () => kaggle.listKernels({ search: q }),
        competitions: () => kaggle.listCompetitions({ search: q }),
        datasets: () => kaggle.listDatasets({ search: q }),
        status: async () => [await kaggle.kernelStatus(ref)],
      };
      return json(res, 200, { ok: true, items: await (map[action] || map.kernels)() });
    }

    if (req.method === 'POST' && p === '/api/hardware') {
      const os = await import('node:os');
      return json(res, 200, {
        ok: true,
        cpus: os.cpus().length,
        model: os.cpus()[0]?.model,
        memGB: Math.round(os.totalmem() / 1e9),
        freeGB: Math.round(os.freemem() / 1e9),
        platform: os.platform(),
        uptimeH: Math.round(os.uptime() / 3600),
      });
    }

    return json(res, 404, { ok: false, error: 'no route' });
  } catch (e) {
    log('request error', p, e.message);
    if (!res.headersSent) return json(res, 200, { ok: false, error: String(e.message || e) });
    try {
      sse(res, 'error', { message: String(e.message || e) });
      res.end();
    } catch {}
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Another Nexus is already running on ${PORT} — opening it instead of starting a second copy.`);
    const url = `http://127.0.0.1:${PORT}`;
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true }).unref();
    setTimeout(() => process.exit(0), 800);
    return;
  }
  log('server error', e.message);
});

server.listen(PORT, '127.0.0.1', () => {
  scheduler.start();
  // Phase 3 cognitive sleep
  sleepcycle.ensureMorningSchedule(8, 30).then((r) => log('morning schedule', r)).catch((e) => log('morning schedule failed', e.message));
  sleepcycle.startIdleWatcher();
  plugins.loadAll().then((list) => log(`plugins: ${list.filter(p=>p.loaded).length}/${list.length} loaded`)).catch((e) => log('plugins failed', e.message));

  mcp.syncServers().catch((e) => log('mcp sync failed', e.message));
  try {
    const enabled = skillstore.ensureDefaults();
    if (enabled.length) log(`skills enabled by default: ${enabled.length}`);
  } catch {}
  // Warm the two calls the first page load needs, so the UI is not blank for seconds.
  llm.warm();
  browser.browserStatus({ fresh: true }).catch(() => {});
  log(`Nexus running at http://127.0.0.1:${PORT}`);
  const open = process.argv.includes('--no-open') ? false : true;
  if (open) {
    const url = `http://127.0.0.1:${PORT}`;
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true }).unref();
    else spawn('xdg-open', [url], { detached: true }).unref();
  }
});

process.on('uncaughtException', (e) => log('uncaught', e.message));
process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
