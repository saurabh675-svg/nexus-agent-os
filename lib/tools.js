import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { settings, WORKSPACE, ROOT, PLATFORM } from './config.js';
import { search as webSearch, readPage } from './search.js';
import * as browser from './browser.js';
import * as webbrowser from './webbrowser.js';
import * as desktop from './desktop.js';
import * as subagents from './subagents.js';
import { chromeBin } from './config.js';
import * as memory from './memory.js';
import * as google from './google.js';
import * as kaggle from './kaggle.js';
import * as skills from './skills.js';
import * as policy from './policy.js';
import * as brain from './brain.js';
import * as intel from './intel.js';
import * as jobs from './jobs.js';
import * as indexer from './indexer.js';
import * as radar from './radar.js';
import * as hooks from './hooks.js';
import * as runtime from './runtime.js';
import * as vision from './vision.js';
import * as delegate from './delegate.js';
import * as pipeline from './pipeline.js';
import { ensureDir, truncate, insidePath } from './util.js';

/* ------------------------------- shell guard ------------------------------ */

const DESTRUCTIVE = [
  /format-volume/i,
  /\bdiskpart\b/i,
  /cipher\s+\/w/i,
  /bcdedit/i,
  /vssadmin\s+delete/i,
  /Remove-Item\s+.*-Recurse\s+.*([A-Z]:\\\\?|~\/|\/)\s*$/i,
  /rm\s+-rf\s+(\/|~|\$HOME)\s*$/i,
  /del\s+\/[fsq]\s+[A-Z]:\\\s*/i,
  /shutdown\s+\/[sr]/i,
  /Restart-Computer|Stop-Computer/i,
  /reg\s+delete\s+HKLM/i,
  /mkfs|dd\s+if=.*of=\/dev\//i,
];

export function runShell(command, { timeoutMs, cwd } = {}) {
  const cfg = settings().shell;
  if (!cfg.enabled) throw new Error('Shell access is disabled in Settings.');
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('empty command');
  const blocked = DESTRUCTIVE.find((re) => re.test(cmd));
  if (blocked) throw new Error(`Blocked destructive command (matched ${blocked}). Refusing to run.`);

  const workdir = cwd ? path.resolve(WORKSPACE, cwd) : WORKSPACE;
  ensureDir(workdir);
  const isWin = process.platform === 'win32';
  const limit = Math.min(Number(timeoutMs) || cfg.timeoutMs || 120000, 900000);

  return new Promise((resolve, reject) => {
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
          cwd: workdir,
          windowsHide: true,
        })
      : spawn('bash', ['-lc', cmd], { cwd: workdir });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      if (isWin && child.pid) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
      else {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, limit);
    child.stdout.on('data', (d) => {
      if (out.length < 400000) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (err.length < 200000) err += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        code,
        timedOut: killed,
        cwd: workdir,
        stdout: truncate(out, 18000),
        stderr: truncate(err, 6000),
      };
      // Semantic Event Bus → Action Center
      import('./eventbus.js')
        .then(({ bus }) => {
          if (code && code !== 0) {
            bus.shellExit({ code, stderr: result.stderr, stdout: result.stdout?.slice(0, 400), command: cmd });
            if (/ModuleNotFoundError|error:|Exception|Traceback/i.test(result.stderr || '')) {
              bus.terminalError({ code, stderr: result.stderr, command: cmd });
            }
          } else {
            bus.shellExit({ code: 0, command: cmd });
          }
        })
        .catch(() => {});
      resolve(result);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      import('./eventbus.js')
        .then(({ bus }) => bus.terminalError({ error: String(e.message || e), command: cmd }))
        .catch(() => {});
      reject(e);
    });
  });
}

/* -------------------------------- fs tools -------------------------------- */

const WRITE_BLOCK = [/^[A-Za-z]:\\Windows/i, /^[A-Za-z]:\\Program Files/i, /^\/etc\//, /^\/System\//];

function resolvePath(p) {
  if (!p) throw new Error('path required');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE, p);
  return abs;
}

function assertWritable(abs) {
  if (WRITE_BLOCK.some((re) => re.test(abs))) throw new Error(`Refusing to write to system path: ${abs}`);
  if (!insidePath(ROOT, abs) && !insidePath(PLATFORM.home, abs)) {
    throw new Error(`Path outside allowed roots: ${abs}`);
  }
}

export const files = {
  list(dir = '.') {
    const abs = resolvePath(dir);
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 400).map((e) => {
      let size = 0;
      try {
        size = e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0;
      } catch {}
      return { name: e.name, dir: e.isDirectory(), size };
    });
    return { path: abs, items };
  },
  read(p, maxChars = 12000) {
    const abs = resolvePath(p);
    const buf = fs.readFileSync(abs);
    if (buf.length > 2_000_000) return { path: abs, text: truncate(buf.subarray(0, 2_000_000).toString('utf8'), maxChars) };
    return { path: abs, text: truncate(buf.toString('utf8'), maxChars) };
  },
  write(p, content) {
    const abs = resolvePath(p);
    assertWritable(abs);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, String(content ?? ''), 'utf8');
    return { path: abs, bytes: fs.statSync(abs).size };
  },
  append(p, content) {
    const abs = resolvePath(p);
    assertWritable(abs);
    ensureDir(path.dirname(abs));
    fs.appendFileSync(abs, String(content ?? ''), 'utf8');
    return { path: abs };
  },
  delete(p) {
    const abs = resolvePath(p);
    assertWritable(abs);
    fs.rmSync(abs, { recursive: true, force: true });
    return { path: abs, deleted: true };
  },
  find(pattern, dir = '.', limit = 60) {
    const abs = resolvePath(dir);
    const out = [];
    const walk = (d, depth) => {
      if (depth > 6 || out.length >= limit) return;
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
        const full = path.join(d, e.name);
        const needle = String(pattern).replace(/\*/g, '');
        if (e.isDirectory()) walk(full, depth + 1);
        else if (full.toLowerCase().includes(needle.toLowerCase())) out.push(full);
      }
    };
    walk(abs, 0);
    return { dir: abs, matches: out };
  },
};

/* --------------------------------- registry -------------------------------- */

export const TOOLS = {
  web_search: {
    desc: 'Search the live web. Returns titles, URLs and snippets.',
    params: { query: 'string', max: 'number?' },
    async run({ query, max }) {
      const r = await webSearch(query, { max });
      return {
        ok: r.results.length > 0,
        query,
        results: r.results,
        note: r.results.length ? undefined : `No results. ${r.errors.join('; ')}`,
      };
    },
  },

  open_page: {
    desc: 'Fetch one URL and return its readable text.',
    params: { url: 'string', maxChars: 'number?' },
    async run({ url, maxChars }) {
      const r = await readPage(url, maxChars || 9000);
      return { ok: r.status < 400, url: r.url, status: r.status, text: r.text };
    },
  },

  browser: {
    desc: 'Browse the web. Uses built-in engine (no Chrome needed) by default, or real Chrome/Edge CDP when available. action=launch|status|tabs|open|snapshot|click|type|press|scroll|screenshot|close. Set engine via Settings browser.engine: auto|builtin|cdp',
    params: {
      action: 'string',
      url: 'string?',
      index: 'number? (element id from snapshot)',
      text: 'string?',
      key: 'string?',
      ms: 'number?',
      y: 'number?',
      id: 'string? tab id (activate / close_tab)',
      x: 'number? mouse x',
      y: 'number? mouse y',
      label: 'string? field label for fill',
      value: 'string? value for fill',
      path: 'string? file path for upload',
      selector: 'string? css selector',
      text2: 'string? text to wait for',
      timeoutMs: 'number?',
      frame: 'number? iframe index',
      model: 'string? vision model for see/locate/click_vision',
    },
    async run({ action, url, index, text, key, ms, y, id, x, label, value, path: filePath, selector, text2, timeoutMs, frame, model }) {
      // Resolve engine: builtin never needs Chrome; cdp requires Chrome/Edge; auto prefers CDP if binary+port else builtin
      const engSetting = settings().browser?.engine || 'auto';
      const cdpUp = await browser.browserStatus({ fresh: true }).then((s) => s.running).catch(() => false);
      const hasBin = !!chromeBin();
      const useBuiltin =
        engSetting === 'builtin' ||
        (engSetting === 'auto' && !cdpUp && action !== 'launch') ||
        (engSetting === 'auto' && action === 'launch' && !hasBin) ||
        (engSetting === 'cdp' && !hasBin && !cdpUp);

      if (useBuiltin || engSetting === 'builtin') {
        switch (action) {
          case 'launch':
            return webbrowser.launch({ url: url || 'about:blank' });
          case 'status':
            return { ok: true, ...webbrowser.status(), cdpAvailable: hasBin };
          case 'tabs':
            return { ok: true, tabs: webbrowser.listTabs(), engine: 'builtin' };
          case 'open':
          case 'navigate':
            if (!webbrowser.status().running) return webbrowser.open(url || 'about:blank');
            return webbrowser.navigate(url || 'about:blank');
          case 'new_tab':
            return webbrowser.open(url || 'about:blank');
          case 'activate':
            return { ok: true, active: webbrowser.activateTab(id) };
          case 'close_tab':
            return { ok: true, closed: webbrowser.closeTab(id) };
          case 'snapshot': {
            const s = webbrowser.snapshot({ tabId: id });
            return { ok: true, ...s, text: truncate(s.text, 4000) };
          }
          case 'click': {
            const r = await webbrowser.click({ index: Number.isFinite(index) ? index : undefined, text, tabId: id });
            let s = null;
            try { s = webbrowser.snapshot(); } catch {}
            return { ok: true, result: r, url: s?.url || r.url, title: s?.title || r.title, text: s ? truncate(s.text, 2500) : undefined, engine: 'builtin' };
          }
          case 'type': {
            const r = await webbrowser.type({ index: Number(index), text: text || '', submit: false, tabId: id });
            return { ok: true, result: r, engine: 'builtin' };
          }
          case 'press': {
            const r = await webbrowser.press({ key: key || 'Enter', tabId: id });
            return { ok: true, result: r, engine: 'builtin' };
          }
          case 'scroll':
            return { ok: true, ...(await webbrowser.scroll()) };
          case 'screenshot':
            return { ok: true, ...(await webbrowser.screenshot({ tabId: id })) };
          case 'close':
            return webbrowser.closeAll();
          case 'wait':
            await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 500, 10000)));
            return { ok: true, waited: ms || 500, engine: 'builtin' };
          default:
            // mouse/vision not available in builtin
            if (['mouse', 'hover', 'see', 'locate', 'click_vision', 'upload', 'frames'].includes(action)) {
              return {
                ok: false,
                error: `action "${action}" needs real Chrome/Edge CDP. Settings → browser.engine = cdp (and install Chrome), or use open/snapshot/click/type in built-in mode.`,
                engine: 'builtin',
              };
            }
            throw new Error(`unknown browser action: ${action}`);
        }
      }

      switch (action) {
        case 'activate':
          return { ok: true, active: await browser.activateTab(id) };
        case 'close_tab':
          return { ok: true, closed: await browser.closeTab(id) };
        case 'mouse':
          return { ok: true, result: await browser.mouseClick({ x, y, button: key || 'left', clickCount: Number(ms) || 1 }) };
        case 'hover':
          return { ok: true, result: await browser.hover({ x, y }) };
        case 'rightclick':
          return { ok: true, result: await browser.rightClick({ x, y }) };
        case 'doubleclick':
          return { ok: true, result: await browser.doubleClick({ x, y }) };
        case 'drag':
          return { ok: true, result: await browser.drag({ fromX: x, fromY: y, toX: Number(selector), toY: Number(index) }) };
        case 'wheel':
          return { ok: true, ...(await browser.wheel({ deltaY: Number(ms) || 600, deltaX: Number(timeoutMs) || 0, x: x || 640, y: y || 360 })) };
        case 'move':
          return { ok: true, result: await browser.mouseMove({ x, y }) };
        case 'waitfor': {
          const r = await browser.waitFor({ text: text2 || text, selector, timeoutMs });
          const s = await browser.snapshot().catch(() => null);
          return { ok: r.found, ...r, url: s?.url, title: s?.title, text: s ? truncate(s.text, 1500) : undefined };
        }
        case 'fill': {
          const r = await browser.fillByLabel({ label: label || text, value });
          return { ...r };
        }
        case 'upload': {
          const r = await browser.upload({ selector: selector || 'input[type=file]', path: filePath });
          const s = await browser.snapshot().catch(() => null);
          return { ...r, url: s?.url, title: s?.title };
        }
        case 'frames':
          return { ok: true, frames: await browser.frames() };
        case 'see':
          return await vision.see({ question: text2 || text, model });
        case 'locate':
          return await vision.locate({ target: text2 || text, model });
        case 'click_vision':
          return await vision.clickByVision({ target: text2 || text, model });
        case 'eval_frame':
          return { ok: true, result: await browser.evalInFrame({ index: frame || 0, expression: text }) };
        case 'evaluate':
          return { ok: true, result: await browser.evaluate(String(text || 'undefined')) };
        case 'launch':
          return await browser.launchBrowser({ url });
        case 'status':
          return await browser.browserStatus();
        case 'tabs':
          return { tabs: await browser.listTabs() };
        case 'new_tab':
          return await browser.newTab(url || 'about:blank');
        case 'open':
          return await browser.navigate(url);
        case 'snapshot': {
          const s = await browser.snapshot();
          return {
            ok: true,
            url: s.url,
            title: s.title,
            text: truncate(s.text, 5000),
            elements: s.items.slice(0, 120),
          };
        }
        case 'click': {
          const r = await browser.click({ index: Number.isFinite(index) ? index : undefined, text });
          const s = await browser.snapshot().catch(() => null);
          return { ok: true, result: r, url: s?.url, title: s?.title, text: s ? truncate(s.text, 2500) : undefined };
        }
        case 'type': {
          const r = await browser.type({ index: Number(index), text: text || '', submit: false });
          return { ok: true, result: r };
        }
        case 'press': {
          const r = await browser.press({ key: key || 'Enter' });
          const s = await browser.snapshot().catch(() => null);
          return { ok: true, result: r, url: s?.url, title: s?.title, text: s ? truncate(s.text, 2500) : undefined };
        }
        case 'scroll':
          return { ok: true, y: await browser.scroll({ y }) };
        case 'wait':
          return { ok: true, value: await browser.sleepFor({ ms }) };
        case 'screenshot': {
          const shot = await browser.screenshot({});
          return { ok: true, file: shot.file, note: 'Screenshot saved and visible in the Browser app.' };
        }
        case 'close':
          return { ok: true, stopped: await browser.stopBrowser() };
        default:
          throw new Error(`unknown browser action: ${action}`);
      }
    },
  },

  desktop: {
    desc: 'Control the whole PC (gated). action=screenshot|click|type|hotkey. Uses OS APIs (PowerShell/xdotool/osascript). High risk — requires approval in Ask mode.',
    params: {
      action: 'string',
      x: 'number?',
      y: 'number?',
      text: 'string?',
      keys: 'string? (e.g. ctrl+c)',
      double: 'boolean?',
    },
    async run({ action, x, y, text, keys, double }) {
      switch (action) {
        case 'screenshot':
          return desktop.screenshotDesktop();
        case 'click':
          return desktop.clickAt(x, y, { double: !!double });
        case 'type':
          return desktop.typeText(text || '');
        case 'hotkey':
          return desktop.hotkey(keys || text || '');
        default:
          throw new Error('desktop action=screenshot|click|type|hotkey');
      }
    },
  },

  subagent: {
    desc: 'Run parallel focused subagents. workers=[{role,prompt}]. Returns combined summary.',
    params: { goal: 'string', workers: 'array' },
    async run({ goal, workers }) {
      // Lightweight: each worker is a single LLM turn without nested tools (safe default)
      const { chat } = await import('./llm.js');
      const runOne = async (w, prompt) => {
        const r = await chat([{ role: 'user', content: prompt }], { maxTokens: 1200 });
        return r?.content || r?.text || String(r || '');
      };
      return subagents.runParallel({ goal, workers: workers || [], runOne });
    },
  },

  shell: {
    desc: 'Run a PowerShell command on this PC (python, git, pip, ffmpeg, kaggle…). Returns stdout/stderr.',
    params: { command: 'string', timeoutSec: 'number?', cwd: 'string?' },
    async run({ command, timeoutSec, cwd }) {
      const r = await runShell(command, { timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined, cwd });
      return { ok: r.code === 0, ...r };
    },
  },

  files: {
    desc: 'Read/write files. action=list|read|write|append|delete|find. Relative paths resolve to data/workspace.',
    params: { action: 'string', path: 'string?', content: 'string?', pattern: 'string?', dir: 'string?' },
    async run({ action, path: p, content, pattern, dir }) {
      switch (action) {
        case 'list':
          return { ok: true, ...files.list(p || dir || '.') };
        case 'read':
          return { ok: true, ...files.read(p || dir) };
        case 'write':
          return { ok: true, ...files.write(p || dir, content) };
        case 'append':
          return { ok: true, ...files.append(p || dir, content) };
        case 'delete':
          return { ok: true, ...files.delete(p || dir) };
        case 'find':
          return { ok: true, ...files.find(pattern || '*', p || dir || '.') };
        default:
          throw new Error(`unknown files action: ${action}`);
      }
    },
  },

  memory: {
    desc: 'Long-term memory. action=search|save. Use save for durable user facts and preferences.',
    params: { action: 'string', query: 'string?', text: 'string?' },
    async run({ action, query, text }) {
      if (action === 'save') return { ok: true, saved: memory.save(text, { scope: 'agent' }) };
      return { ok: true, matches: memory.search(query || text || '', 6) };
    },
  },

  brain: {
    desc: 'Your long-term knowledge about the user, their projects, deadlines and past work. action=search|save|profile. Use save whenever you learn a durable fact (a real preference, a deadline, a decision, a lesson).',
    params: {
      action: 'string (search|save|profile)',
      query: 'string?',
      kind: 'string? (fact|project|task|decision|lesson|competition|person|preference)',
      title: 'string?',
      text: 'string?',
      tags: 'string?',
      deadline: 'string? ISO date',
    },
    async run({ action, query, kind, title, text, tags, deadline }) {
      if (action === 'save') {
        const entry = brain.add({
          kind: kind || 'fact',
          title: title || text,
          body: text || title,
          tags,
          source: 'agent',
          meta: deadline ? { deadline } : {},
        });
        return { ok: true, saved: { id: entry.id, kind: entry.kind, title: entry.title } };
      }
      if (action === 'profile') return { ok: true, profile: brain.profile(), stats: brain.stats() };
      const hits = brain.search(query || text || '', 8);
      return {
        ok: true,
        matches: hits.map((h) => ({ id: h.id, kind: h.kind, title: h.title, body: truncate(h.body, 500), tags: h.tags })),
      };
    },
  },

  gmail: {
    desc: 'Your Gmail. action=search|read|send.',
    params: { action: 'string', query: 'string?', id: 'string?', to: 'string?', subject: 'string?', body: 'string?' },
    async run({ action, query, id, to, subject, body }) {
      if (!google.isConnected()) return { ok: false, error: 'Gmail not connected. Open the Google app and click Connect.' };
      if (action === 'search') return { ok: true, messages: await google.gmailSearch(query, 8) };
      if (action === 'read') return { ok: true, message: await google.gmailRead(id) };
      if (action === 'send') return { ok: true, sent: await google.gmailSend({ to, subject, body }) };
      throw new Error(`unknown gmail action: ${action}`);
    },
  },

  calendar: {
    desc: 'Google Calendar. action=list|create.',
    params: { action: 'string', days: 'number?', title: 'string?', start: 'string?', end: 'string?', attendees: 'array?' },
    async run({ action, days, title, start, end, attendees }) {
      if (!google.isConnected()) return { ok: false, error: 'Google not connected.' };
      if (action === 'create') return { ok: true, event: await google.calendarCreate({ title, start, end, attendees }) };
      return { ok: true, events: await google.calendarList({ days: days || 7 }) };
    },
  },

  drive: {
    desc: 'Google Drive. action=search|read.',
    params: { action: 'string', query: 'string?', fileId: 'string?' },
    async run({ action, query, fileId }) {
      if (!google.isConnected()) return { ok: false, error: 'Google not connected.' };
      if (action === 'read') return { ok: true, file: await google.driveRead(fileId) };
      return { ok: true, files: await google.driveSearch(query, 12) };
    },
  },

  sheets: {
    desc: 'Google Sheets. action=get|append|create.',
    params: { action: 'string', spreadsheetId: 'string?', range: 'string?', values: 'array?', title: 'string?' },
    async run({ action, spreadsheetId, range, values, title }) {
      if (!google.isConnected()) return { ok: false, error: 'Google not connected.' };
      if (action === 'create') return { ok: true, sheet: await google.sheetsCreate(title) };
      if (action === 'append') return { ok: true, ...(await google.sheetsAppend(spreadsheetId, range || 'A1', values || [])) };
      return { ok: true, ...(await google.sheetsGet(spreadsheetId, range || 'A1:Z100')) };
    },
  },

  kaggle: {
    desc: 'Kaggle API. action=login|kernels|status|output|log|push|competitions|datasets.',
    params: { action: 'string', ref: 'string?', search: 'string?', dir: 'string?' },
    async run({ action, ref, search, dir }) {
      if (!kaggle.isConfigured()) return { ok: false, error: 'Kaggle credentials missing (Settings → Kaggle).' };
      switch (action) {
        case 'login': {
          const file = kaggle.writeKaggleJson();
          return { ok: true, ...(await kaggle.whoAmI()), kaggleJson: file };
        }
        case 'status':
          return { ok: true, ...(await kaggle.kernelStatus(ref)) };
        case 'output':
          return { ok: true, ...(await kaggle.kernelOutput(ref)) };
        case 'log':
          return { ok: true, ref, log: await kaggle.kernelLog(ref) };
        case 'push':
          return { ok: true, ...(await kaggle.pushKernel(dir)) };
        case 'competitions':
          return { ok: true, competitions: await kaggle.listCompetitions({ search }) };
        case 'datasets':
          return { ok: true, datasets: await kaggle.listDatasets({ search }) };
        case 'kernels':
        default:
          return { ok: true, kernels: await kaggle.listKernels({ search }) };
      }
    },
  },

  pipeline: {
    desc: 'Track a bounty/competition from discovery to a submittable package. action=list|add|advance. You may advance up to “ready”; anything from “awaiting_human” onward needs a human and the tool will refuse.',
    params: { action: 'string', id: 'string?', title: 'string?', url: 'string?', kind: 'string?', deadline: 'string?', prize: 'string?', source: 'string?', to: 'string?', note: 'string?' },
    async run({ action = 'list', id, to, note, ...rest }) {
      if (action === 'add') return { ok: true, ...pipeline.add(rest) };
      if (action === 'advance') return { ok: true, ...pipeline.advance(id, to, { actor: 'agent', note }) };
      return { ok: true, ...pipeline.summary() };
    },
  },

  delegate: {
    desc: 'Hand a self-contained coding task to an EXTERNAL agent CLI (claude / codex / opencode) when one is installed. Returns that agent’s output. Use only when the user wants another agent to do heavy repo work.',
    params: { cli: 'string? auto|claude|codex|opencode', prompt: 'string', cwd: 'string?', timeoutSec: 'number?' },
    async run(a) {
      const r = await delegate.run(a);
      return { ...r };
    },
  },

  runtime: {
    desc: 'Fast script runner. action=detect|bench|run. Runs Python when the code looks like Python or lang=python; otherwise Bun (fast startup, TypeScript) or Node. Use run for short scripts; use job for long ones.',
    params: { action: 'string', file: 'string?', code: 'string?', lang: 'string? python|js', runtime: 'string? auto|bun|node|python', args: 'array?', timeoutSec: 'number?', cwd: 'string?' },
    async run({ action = 'detect', file, code, lang, runtime: rt, args, timeoutSec, cwd }) {
      if (action === 'bench') return { ok: true, ...(await runtime.bench()) };
      if (action === 'run') return { ok: true, ...(await runtime.runScript({ file, code, lang, runtime: rt || 'auto', args, timeoutSec: (timeoutSec || 120) * 1000, cwd })) };
      return { ok: true, ...runtime.detect({ fresh: true }) };
    },
  },

  job: {
    desc: 'Run something that takes minutes to hours and keep its log. action=run|list|status|log|kill. ALWAYS use this instead of shell for python scripts, Kaggle polling, GEE exports or deck builds, so the job survives and the log is readable.',
    params: {
      action: 'string',
      command: 'string?',
      cwd: 'string?',
      label: 'string?',
      timeoutSec: 'number?',
      id: 'string?',
      lines: 'number?',
      kind: 'string? shell|bun|node',
      file: 'string? script path for bun/node',
      args: 'array?',
    },
    async run({ action, command, cwd, label, timeoutSec, id, lines, kind, file, args }) {
      if (action === 'run') return { ok: true, job: jobs.run({ command, cwd, label, timeoutSec, kind, file, args }) };
      if (action === 'kill') return { ok: true, ...jobs.kill(id) };
      if (action === 'list') return { ok: true, jobs: jobs.list() };
      if (action === 'log') return { ok: true, ...jobs.tail(id, lines || 80) };
      return { ok: true, ...jobs.get(id, 0) };
    },
  },

  index: {
    desc: 'Search the user\'s own PC index (every file on disk) or get cleanup suggestions. action=search|suggestions|collections|stats.',
    params: { action: 'string', q: 'string?', limit: 'number?' },
    async run({ action, q, limit }) {
      if (action === 'suggestions') return { ok: true, items: indexer.suggestions() };
      if (action === 'collections') return { ok: true, items: indexer.collections() };
      if (action === 'stats') return { ok: true, stats: indexer.stats() };
      return { ok: true, items: indexer.search(q, limit || 40) };
    },
  },

  radar: {
    desc: 'Opportunity radar for India and worldwide (competitions, grants, bounties, remote work). action=scan|dive. scan stores new findings in the brain.',
    params: { action: 'string', url: 'string?' },
    async run({ action, url }) {
      if (action === 'dive') return { ok: true, ...(await radar.dive(url)) };
      const r = await radar.scan({ remember: true });
      return { ok: true, saved: r.saved, items: r.items.slice(0, 12), errors: r.errors, digest: radar.digestText(r) };
    },
  },

  github: {
    desc: 'GitHub. action=search_issues|list_prs|repo|git. Use git to pull, branch, commit, diff or open a local repo.',
    params: {
      action: 'string',
      query: 'string?',
      repo: 'string? owner/name',
      labels: 'string?',
      state: 'string?',
      cmd: 'string? git command',
      cwd: 'string?',
    },
    async run({ action, query, repo, labels, state, cmd, cwd }) {
      switch (action) {
        case 'search_issues':
          return { ok: true, issues: await intel.githubIssues(query || 'good first issue', { labels, limit: 10 }) };
        case 'list_prs':
          return { ok: true, pulls: await intel.githubPRs(repo || settings().github.defaultRepo, { state: state || 'open' }) };
        case 'repo':
          return { ok: true, repo: await intel.githubRepo(repo) };
        case 'git': {
          const r = await runShell(cmd || 'git status', { cwd });
          return { ok: r.code === 0, ...r };
        }
        default:
          throw new Error(`unknown github action: ${action}`);
      }
    },
  },

  intel: {
    desc: 'Opportunity and business intelligence. action=opportunities|plan|rules|save_plan. Use when the user asks how to earn money, what to enter, or whether an action risks a ban.',
    params: { action: 'string', hoursPerWeek: 'number?', skills: 'string? comma separated', platform: 'string?' },
    async run({ action, hoursPerWeek, skills, platform }) {
      const skillList = String(skills || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (action === 'rules') return { ok: true, ...intel.rulesFor(platform) };
      if (action === 'plan') return { ok: true, plan: intel.plan({ hoursPerWeek: hoursPerWeek || 10, skills: skillList }) };
      if (action === 'save_plan') {
        const saved = intel.rememberPlan(intel.plan({ hoursPerWeek: hoursPerWeek || 10, skills: skillList }));
        return { ok: true, saved: saved.map((s) => s.title) };
      }
      return { ok: true, opportunities: await intel.opportunities({ hoursPerWeek: hoursPerWeek || 10, skills: skillList }) };
    },
  },

  schedule: {
    desc: 'Recurring automations. action=list|create|delete|run.',
    params: { action: 'string', when: 'string? e.g. "every 30m" or "daily 09:00"', prompt: 'string?', label: 'string?', id: 'string?' },
    async run({ action, when, prompt, label, id }) {
      const sched = await import('./scheduler.js');
      if (action === 'create') return { ok: true, task: sched.create({ when, prompt, label }) };
      if (action === 'delete') return { ok: true, ...sched.remove(id) };
      if (action === 'run') return { ok: true, ...(await sched.runNow(id)) };
      return { ok: true, tasks: sched.list() };
    },
  },

  skill: {
    desc: 'Load the full instructions of an installed skill by id.',
    params: { name: 'string' },
    async run({ name }) {
      const s = skills.load(name);
      return { ok: true, id: s.id, body: s.body };
    },
  },

  spawn_agent: {
    desc: 'Delegate a self-contained subtask to a specialised sub-agent and get its answer back.',
    params: { role: 'string (researcher|analyst|planner|executor|critic|writer|viz)', task: 'string' },
    async run({ role, task }, ctx) {
      const { runAgent } = await import('./agentloop.js');
      const r = await runAgent({ role, input: task, depth: (ctx?.depth || 0) + 1, emit: ctx?.emit, signal: ctx?.signal });
      return { ok: true, role: r.role, answer: r.answer, steps: r.steps };
    },
  },

  /* -------------------- 6.7 upgrades: recipes, synthesizer, apps, briefing -------------------- */

  recipe: {
    desc: 'Portable agent workflows. action=list|get|save|delete|run. Use run with id + params to execute a recipe.',
    params: {
      action: 'string (list|get|save|delete|run)',
      id: 'string?',
      name: 'string?',
      description: 'string?',
      system: 'string?',
      tools: 'string[]?',
      params: 'object?',
      schedule: 'string?',
      paramValues: 'object?',
    },
    async run(args, ctx) {
      const recipes = await import('./recipes.js');
      recipes.seedExampleRecipes();
      const a = args.action || 'list';
      if (a === 'list') return { ok: true, recipes: recipes.listRecipes() };
      if (a === 'get') return { ok: true, recipe: recipes.getRecipe(args.id) };
      if (a === 'delete') return recipes.deleteRecipe(args.id);
      if (a === 'save') {
        const body = recipes.saveRecipe({
          id: args.id,
          name: args.name,
          description: args.description,
          system: args.system,
          tools: args.tools,
          params: args.params,
          schedule: args.schedule,
        });
        return { ok: true, recipe: body };
      }
      if (a === 'run') {
        const prep = recipes.prepareRecipeRun(args.id, args.paramValues || {});
        const { runAgent } = await import('./agentloop.js');
        const r = await runAgent({
          role: 'core',
          input: prep.task,
          systemOverlay: prep.systemOverlay,
          maxSteps: prep.maxSteps,
          depth: (ctx?.depth || 0) + 1,
          emit: ctx?.emit,
          signal: ctx?.signal,
        });
        return { ok: true, recipe: prep.recipe.id, answer: r.answer, steps: r.steps };
      }
      return { ok: false, error: 'action must be list|get|save|delete|run' };
    },
  },

  synthesize_tool: {
    desc:
      'Zero-code dynamic tool synthesizer. Wrap any CLI / PowerShell / Python one-liner into a callable tool using {{param}} templates. action=create|list|run|delete.',
    params: {
      action: 'string (create|list|run|delete)',
      id: 'string?',
      name: 'string?',
      description: 'string?',
      command: 'string? (template with {{param}} placeholders)',
      shell: 'string? (powershell|cmd|python|bash)',
      params: 'object?',
      argValues: 'object?',
    },
    async run(args) {
      const synthDir = path.join(WORKSPACE, '.nexus-tools');
      ensureDir(synthDir);
      const store = path.join(synthDir, 'synthesized.json');
      let db = {};
      try {
        db = JSON.parse(fs.readFileSync(store, 'utf8'));
      } catch {}
      const a = args.action || 'list';
      if (a === 'list') return { ok: true, tools: Object.values(db) };
      if (a === 'delete') {
        delete db[args.id];
        fs.writeFileSync(store, JSON.stringify(db, null, 2));
        return { ok: true };
      }
      if (a === 'create') {
        const id = String(args.id || args.name || `tool-${Date.now()}`)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .slice(0, 48);
        db[id] = {
          id,
          name: args.name || id,
          description: args.description || '',
          command: args.command,
          shell: args.shell || (PLATFORM.os === 'win32' ? 'powershell' : 'bash'),
          params: args.params || {},
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(store, JSON.stringify(db, null, 2));
        return { ok: true, tool: db[id] };
      }
      if (a === 'run') {
        const t = db[args.id];
        if (!t) return { ok: false, error: 'unknown synthesized tool' };
        let cmd = String(t.command || '');
        const vals = { ...(t.params || {}), ...(args.argValues || {}) };
        cmd = cmd.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) =>
          vals[k] !== undefined ? String(vals[k]) : `{{${k}}}`,
        );
        const r = await runShell(cmd, { timeoutMs: 120000 });
        return { ok: r.code === 0 && !r.timedOut, ...r, command: cmd };
      }
      return { ok: false, error: 'action must be create|list|run|delete' };
    },
  },

  create_app: {
    desc:
      'Self-synthesizing ephemeral micro-app. Creates an interactive HTML/CSS/JS panel the user can open in the Nexus UI (iframe). action=create|list|get|delete. Use for sliders, tables, charts, kill buttons, etc.',
    params: {
      action: 'string (create|list|get|delete)',
      id: 'string?',
      title: 'string?',
      html: 'string?',
      css: 'string?',
      js: 'string?',
      pin: 'boolean?',
    },
    async run(args) {
      const apps = await import('./apps.js');
      // lightweight store under data/micro-apps
      const dir = path.join(path.dirname(WORKSPACE), 'micro-apps');
      ensureDir(dir);
      const indexFile = path.join(dir, 'index.json');
      let index = [];
      try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      } catch {}
      const a = args.action || 'list';
      if (a === 'list') return { ok: true, apps: index };
      if (a === 'get') {
        const meta = index.find((x) => x.id === args.id);
        if (!meta) return { ok: false, error: 'not found' };
        const body = fs.readFileSync(path.join(dir, `${args.id}.html`), 'utf8');
        return { ok: true, app: meta, html: body };
      }
      if (a === 'delete') {
        index = index.filter((x) => x.id !== args.id);
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
        try {
          fs.unlinkSync(path.join(dir, `${args.id}.html`));
        } catch {}
        return { ok: true };
      }
      if (a === 'create') {
        const id = String(args.id || `app-${Date.now()}`)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .slice(0, 48);
        const title = args.title || id;
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '')}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#0f1115;color:#e8eaed} ${args.css || ''}</style>
</head><body>
${args.html || '<p>Empty micro-app</p>'}
<script>${args.js || ''}</script>
</body></html>`;
        fs.writeFileSync(path.join(dir, `${id}.html`), html);
        const meta = { id, title, pinned: !!args.pin, createdAt: new Date().toISOString() };
        index = index.filter((x) => x.id !== id).concat(meta);
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
        return { ok: true, app: meta, open: `/micro-app/${id}` };
      }
      return { ok: false, error: 'action must be create|list|get|delete' };
    },
  },

  morning_briefing: {
    desc: 'Cognitive morning briefing: consolidate memory/brain, list open tasks, deadlines, scheduled automations, and system health. Call with action=generate.',
    params: { action: 'string?', date: 'string?' },
    async run() {
      const mem = await memory.list?.() || [];
      const brainFacts = (await brain.search?.({ q: 'deadline OR task OR project', limit: 12 })) || [];
      let tasks = [];
      try {
        const sched = await import('./scheduler.js');
        tasks = sched.list?.() || [];
      } catch {}
      const lines = [
        `# Morning Briefing — ${new Date().toISOString().slice(0, 10)}`,
        '',
        '## Open automations',
        ...(tasks.length ? tasks.slice(0, 8).map((t) => `- ${t.label || t.id}: ${t.when}`) : ['- (none)']),
        '',
        '## Recent durable notes',
        ...(Array.isArray(mem) ? mem.slice(-6).map((m) => `- ${typeof m === 'string' ? m : m.text || JSON.stringify(m)}`) : ['- (none)']),
        '',
        '## Brain highlights',
        ...(Array.isArray(brainFacts) ? brainFacts.slice(0, 8).map((f) => `- ${f.text || f.fact || JSON.stringify(f)}`) : ['- (none)']),
        '',
        '_Generated by Nexus cognitive sleep / morning_briefing tool._',
      ];
      const text = lines.join('\n');
      try {
        await memory.save?.({ text: `Morning briefing ${new Date().toISOString().slice(0, 10)}` });
      } catch {}
      // Persist for wallpaper widget + Action Center
      try {
        const dir = path.join(path.dirname(WORKSPACE), 'briefings');
        ensureDir(dir);
        fs.writeFileSync(path.join(dir, 'latest.md'), text);
        fs.writeFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`), text);
      } catch {}
      import('./eventbus.js')
        .then(({ bus }) => bus.briefingReady({ date: new Date().toISOString().slice(0, 10) }))
        .catch(() => {});
      return { ok: true, briefing: text };
    },
  },

  dry_run: {
    desc:
      'Predictive Time-Travel dry-run. action=preview for a files write/append/delete or a shell command. Returns predicted mutations and reversibility without executing.',
    params: {
      action: 'string (preview)',
      tool: 'string? (files|shell)',
      path: 'string?',
      content: 'string?',
      command: 'string?',
      fileAction: 'string? (write|append|delete)',
    },
    async run(args) {
      const tool = args.tool || 'files';
      if (tool === 'files') {
        const target = args.path;
        if (!target) return { ok: false, error: 'path required' };
        const abs = path.isAbsolute(target) ? target : path.resolve(WORKSPACE, target);
        const exists = fs.existsSync(abs);
        let current = '';
        try {
          current = exists ? fs.readFileSync(abs, 'utf8') : '';
        } catch {
          current = '(binary or unreadable)';
        }
        const fa = args.fileAction || 'write';
        let predicted = '';
        if (fa === 'delete') predicted = '(file would be deleted)';
        else if (fa === 'append') predicted = current + (args.content || '');
        else predicted = args.content || '';
        const reversible = true; // checkpoint system makes workspace writes reversible
        return {
          ok: true,
          dryRun: true,
          path: abs,
          exists,
          action: fa,
          bytesNow: Buffer.byteLength(current),
          bytesAfter: Buffer.byteLength(String(predicted)),
          reversible,
          reversibilityScore: reversible ? 100 : 0,
          impact: [path.dirname(abs)],
          preview: truncate(String(predicted), 2000),
        };
      }
      if (tool === 'shell') {
        const cmd = String(args.command || '');
        const destructive = DESTRUCTIVE.some((re) => re.test(cmd));
        return {
          ok: true,
          dryRun: true,
          command: cmd,
          blockedIfExecuted: destructive,
          reversible: false,
          reversibilityScore: 0,
          impact: ['process', 'possible network / filesystem outside workspace'],
          note: 'Shell dry-run cannot simulate side effects; high-risk commands stay gated by policy.',
        };
      }
      return { ok: false, error: 'tool must be files or shell' };
    },
  },
};

export function toolHelp() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}(${Object.entries(t.params).map(([k, v]) => `${k}: ${v}`).join(', ')}): ${t.desc}`)
    .join('\n');
}

export async function runTool(name, args, ctx = {}) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` };

  const verdict = await policy.gate(name, args, ctx);
  if (!verdict.allow) {
    return {
      ok: false,
      blocked: true,
      error: `Blocked by policy: ${verdict.reason}. Do not retry the same call; choose another approach or ask the user to change the permission mode.`,
    };
  }

  // Snapshot the previous version of any file we are about to mutate.
  if (policy.classify(name, args).risk !== 'read' && ['files'].includes(name)) {
    try {
      const target = args.path || args.dir;
      if (target && ['write', 'append', 'delete'].includes(args.action)) {
        const abs = path.isAbsolute(target) ? target : path.resolve(WORKSPACE, target);
        const backup = policy.checkpoint(abs);
        if (backup) ctx.emit?.('checkpoint', { file: abs, backup });
      }
    } catch {}
  }

  const started = Date.now();
  try {
    // User hooks can veto the call before it runs. Fail closed: a broken hook blocks the tool.
    const pre = await hooks.pre(name, args);
    if (pre.block) {
      policy.audit({ tool: name, summary: policy.summarize(name, args), decision: 'deny', reason: pre.reason, risk: policy.classify(name, args).risk });
      return { ok: false, blocked: true, error: `Blocked by hook: ${pre.reason}` };
    }
    const result = await tool.run(args || {}, ctx);
    hooks.post(name, args, result, Date.now() - started).catch(() => {});
    policy.audit({
      tool: name,
      summary: policy.summarize(name, args),
      decision: 'executed',
      ok: result?.ok !== false,
      ms: Date.now() - started,
      risk: policy.classify(name, args).risk,
    });
    return result;
  } catch (e) {
    policy.audit({
      tool: name,
      summary: policy.summarize(name, args),
      decision: 'error',
      ok: false,
      ms: Date.now() - started,
      error: String(e.message || e),
    });
    return { ok: false, error: String(e.message || e) };
  }
}
