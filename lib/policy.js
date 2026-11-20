import fs from 'node:fs';
import path from 'node:path';
import { settings, saveSettings, DATA, WORKSPACE, ROOT, PLATFORM } from './config.js';
import { appendJsonl, readJsonl, uid, truncate, ensureDir, insidePath } from './util.js';

/**
 * Policy engine — the piece every serious agent framework converges on:
 * classify a tool call, then allow / deny / ask according to a mode plus explicit rules.
 * Nothing executes without passing through gate().
 */

export const MODES = {
  plan: {
    label: 'Plan',
    desc: 'Research only. No writes, no commands, nothing leaves the machine except searches.',
  },
  ask: {
    label: 'Ask',
    desc: 'Reads run freely. Writes, commands and browser actions ask for approval first. Default.',
  },
  auto: {
    label: 'Auto',
    desc: 'File writes inside the workspace run freely. Commands, deletes and outside-workspace writes still ask.',
  },
  full: {
    label: 'Full',
    desc: 'No prompts. Destructive commands and system paths stay blocked.',
  },
};

const READ = 'read';
const WRITE = 'write';
const EXEC = 'exec';
const DESTRUCTIVE = 'destructive';

export function classify(tool, args = {}) {
  const a = args.action || '';
  switch (tool) {
    case 'web_search':
      return { risk: READ, network: true };
    case 'open_page':
      return { risk: READ, network: true, url: args.url };
    case 'skill':
    case 'memory_search':
      return { risk: READ };
    case 'memory':
      return { risk: a === 'save' ? WRITE : READ };
    case 'brain':
      return { risk: a === 'save' ? WRITE : READ };
    case 'intel':
      return { risk: a === 'save_plan' ? WRITE : READ, network: true };
    case 'github': {
      if (['search_issues', 'list_prs', 'repo', 'pr_diff'].includes(a)) return { risk: READ, network: true };
      if (a === 'git') return { risk: EXEC, command: String(args.cmd || '') };
      return { risk: WRITE, network: true };
    }
    case 'job':
      return { risk: ['run', 'kill'].includes(a) ? EXEC : READ, command: String(args.command || '') };
    case 'delegate':
      return { risk: EXEC, command: String(args.cli || 'auto') };
    case 'index':
      return { risk: READ };
    case 'radar':
      return { risk: a === 'scan' ? WRITE : READ, network: true };
    case 'files':
      if (a === 'delete') return { risk: DESTRUCTIVE, path: args.path };
      if (a === 'write' || a === 'append') return { risk: WRITE, path: args.path };
      return { risk: READ, path: args.path || args.dir };
    case 'shell':
      return { risk: EXEC, command: String(args.command || '') };
    case 'browser':
      if (a === 'launch' || a === 'close') return { risk: EXEC };
      if (a === 'open' || a === 'new_tab') return { risk: WRITE, network: true, url: args.url };
      if (a === 'click' || a === 'type' || a === 'press') return { risk: WRITE, network: true };
      return { risk: READ };
    case 'gmail':
      return { risk: a === 'send' ? WRITE : READ, network: true };
    case 'calendar':
      return { risk: a === 'create' ? WRITE : READ, network: true };
    case 'drive':
    case 'sheets':
      return { risk: a === 'get' || a === 'search' || a === 'read' ? READ : WRITE, network: true };
    case 'kaggle':
      return { risk: a === 'push' ? EXEC : READ, network: true };
    case 'schedule':
      return { risk: ['create', 'delete', 'run'].includes(a) ? WRITE : READ };
    case 'spawn_agent':
      return { risk: EXEC };
    default:
      if (tool.startsWith('mcp__')) return { risk: EXEC, mcp: true };
      return { risk: EXEC };
  }
}

export function summarize(tool, args = {}) {
  const a = args.action ? `${args.action} ` : '';
  if (args.command) return truncate(args.command, 140);
  if (args.url) return truncate(args.url, 140);
  if (args.path) return truncate(args.path, 140);
  if (args.query) return truncate(`${a}${args.query}`, 140);
  if (args.to) return truncate(`${a}to:${args.to}`, 140);
  if (args.ref) return truncate(`${a}${args.ref}`, 140);
  if (args.dir) return truncate(`${a}${args.dir}`, 140);
  if (args.prompt) return truncate(`${a}${args.prompt}`, 140);
  if (args.task) return truncate(`${a}${args.task}`, 140);
  return truncate(a.trim() || JSON.stringify(args).slice(0, 140), 140);
}

function globToRegex(glob) {
  return new RegExp(
    '^' +
      String(glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
}

function matchRules(rules, tool, summary) {
  const subject = `${tool}:${summary}`;
  const hits = [];
  for (const rule of rules || []) {
    if (!rule?.match) continue;
    const re = globToRegex(rule.match);
    if (re.test(subject) || re.test(`${tool}:`)) hits.push(rule);
  }
  return hits;
}

/** Minimal LCS diff, capped — enough to review a change before it lands. */
function diffFor(file, nextText) {
  try {
    if (!fs.existsSync(file)) return { created: true, lines: String(nextText).split('\n').length };
    const before = fs.readFileSync(file, 'utf8').split('\n').slice(0, 300);
    const after = String(nextText).split('\n').slice(0, 300);
    const n = before.length;
    const m = after.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    let added = 0;
    let removed = 0;
    while (i < n && j < m && out.length < 200) {
      if (before[i] === after[j]) {
        out.push('  ' + before[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push('- ' + before[i++]);
        removed++;
      } else {
        out.push('+ ' + after[j++]);
        added++;
      }
    }
    while (i < n && out.length < 200) {
      out.push('- ' + before[i++]);
      removed++;
    }
    while (j < m && out.length < 200) {
      out.push('+ ' + after[j++]);
      added++;
    }
    return { added, removed, text: out.join('\n').slice(0, 6000) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function isInsideWorkspace(p) {
  if (!p) return true;
  const abs = path.isAbsolute(p) ? p : path.resolve(WORKSPACE, p);
  return insidePath(WORKSPACE, abs) || insidePath(ROOT, abs);
}

/** Pure decision function — unit-testable, no side effects. */
export function decide(tool, args = {}, overrides = {}) {
  const p = { ...settings().policy, ...overrides };
  const risk = classify(tool, args);
  const summary = summarize(tool, args);
  const mode = p.mode || 'ask';

  const matched = matchRules(p.rules || [], tool, summary);
  if (matched.length) {
    const denyRule = matched.find((r) => r.decision === 'deny');
    if (denyRule) return { decision: 'deny', reason: `rule “${denyRule.match}”`, risk, summary, rule: true };
    const best = matched.sort((a, b) => String(b.match).length - String(a.match).length)[0];
    return { decision: 'allow', reason: `rule “${best.match}”`, risk, summary, rule: true };
  }

  if (risk.risk === DESTRUCTIVE) {
    return { decision: 'deny', reason: 'destructive operation — always blocked', risk, summary };
  }

  const askOr = (reason) => ({ decision: 'ask', reason, risk, summary });
  const allow = () => ({ decision: 'allow', reason: `${mode} mode`, risk, summary });

  if (mode === 'plan') {
    return risk.risk === READ ? allow() : { decision: 'deny', reason: 'plan mode is read-only', risk, summary };
  }
  if (mode === 'ask') {
    return risk.risk === READ ? allow() : askOr(`${risk.risk} action needs your approval`);
  }
  if (mode === 'auto') {
    if (risk.risk === READ) return allow();
    if (risk.risk === WRITE) {
      if (risk.path && !isInsideWorkspace(risk.path)) return askOr('write outside the workspace');
      return allow();
    }
    return askOr(`${risk.risk} action needs your approval in auto mode`);
  }
  return allow();
}

/* ------------------------------ approvals ------------------------------ */

const pending = new Map();

export function requestApproval({ tool, args, reason, risk, summary }, onCreated, { signal } = {}) {
  const id = uid('ap_');
  const timeoutSec = Number(settings().policy.approveTimeoutSec) || 180;
  const payload = { id, tool, args, reason, risk: risk?.risk || 'exec', summary, requestedAt: Date.now(), timeoutSec };
  if (signal?.aborted) {
    audit({ tool, summary, decision: 'deny', reason: 'run stopped before approval', risk: payload.risk });
    return Promise.resolve({ id, decision: 'deny', reason: 'run stopped before approval' });
  }
  onCreated?.(payload);
  return new Promise((resolve) => {
    const finish = (decision) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      resolve({ ...decision, id });
    };
    const onAbort = () => {
      if (!pending.has(id)) return;
      audit({ tool, summary, decision: 'deny', reason: 'run stopped while waiting for approval', risk: payload.risk });
      finish({ decision: 'deny', reason: 'run stopped while waiting for approval' });
    };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      audit({ tool, summary, decision: 'deny', reason: 'approval timed out', risk: payload.risk });
      finish({ decision: 'deny', reason: 'approval timed out' });
    }, timeoutSec * 1000);
    pending.set(id, {
      payload,
      finish,
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function resolveApproval(id, decision, scope = 'once') {
  const entry = pending.get(id);
  if (!entry) throw new Error('no such approval request (it may have expired)');
  const allow = decision === 'allow';
  if (allow && (scope === 'session' || scope === 'always')) {
    const rule = { match: `${entry.payload.tool}:${entry.payload.summary}`, decision: 'allow', scope };
    const cur = settings().policy.rules || [];
    if (!cur.some((r) => r.match === rule.match)) saveSettings({ policy: { rules: [...cur, rule] } });
  }
  audit({
    tool: entry.payload.tool,
    summary: entry.payload.summary,
    decision: allow ? 'allow' : 'deny',
    reason: `user ${allow ? 'approved' : 'denied'} (${scope})`,
    risk: entry.payload.risk,
  });
  entry.finish({ decision: allow ? 'allow' : 'deny', reason: `user ${allow ? 'approved' : 'denied'}` });
  return { ok: true, id, decision: allow ? 'allow' : 'deny' };
}

export function pendingApprovals() {
  return [...pending.values()].map((v) => v.payload);
}

/* --------------------------------- audit -------------------------------- */

const AUDIT = path.join(DATA, 'audit.jsonl');

export function audit(entry) {
  try {
    appendJsonl(AUDIT, { ts: new Date().toISOString(), ...entry });
  } catch {}
}

export function readAudit(limit = 200) {
  return readJsonl(AUDIT).slice(-limit).reverse();
}

/* ------------------------------ checkpoints ----------------------------- */

const CP_DIR = path.join(DATA, 'checkpoints');
const CP_INDEX = path.join(CP_DIR, 'index.jsonl');

export function checkpoint(file) {
  if (!settings().policy.checkpoint) return null;
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    ensureDir(CP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(CP_DIR, `${stamp}__${path.basename(file)}`);
    fs.copyFileSync(file, backup);
    appendJsonl(CP_INDEX, { ts: new Date().toISOString(), file, backup, size: fs.statSync(file).size });
    return backup;
  } catch {
    return null;
  }
}

export function listCheckpoints(limit = 100) {
  return readJsonl(CP_INDEX).slice(-limit).reverse();
}

export function restoreCheckpoint(backup) {
  const idx = readJsonl(CP_INDEX).find((c) => c.backup === backup || c.ts === backup);
  if (!idx) throw new Error('checkpoint not found');
  if (!fs.existsSync(idx.backup)) throw new Error('backup file missing on disk');
  ensureDir(path.dirname(idx.file));
  fs.copyFileSync(idx.backup, idx.file);
  audit({ tool: 'files.restore', summary: idx.file, decision: 'allow', reason: 'checkpoint restore', risk: 'write' });
  return { restored: idx.file, from: idx.backup };
}

/* --------------------------------- gate --------------------------------- */

/**
 * Single choke point. Returns { allow, reason } and handles the ask/deny flow,
 * including pushing the approval request to the UI and waiting for the answer.
 */
export async function gate(tool, args, ctx = {}) {
  const verdict = decide(tool, args, ctx.policyMode ? { mode: ctx.policyMode } : {});
  if (verdict.decision === 'allow') {
    audit({ tool, summary: verdict.summary, decision: 'allow', reason: verdict.reason, risk: verdict.risk.risk, args });
    return { allow: true, reason: verdict.reason };
  }
  if (verdict.decision === 'deny') {
    audit({ tool, summary: verdict.summary, decision: 'deny', reason: verdict.reason, risk: verdict.risk.risk, args });
    return { allow: false, reason: verdict.reason };
  }

  const request = { tool, args, reason: verdict.reason, risk: verdict.risk, summary: verdict.summary };
  const answer = await requestApproval(request, (full) => {
    const extra = {};
    // Diff-preview before writes (Time-Travel card)
    if (tool === 'files' && ['write', 'append', 'delete'].includes(args.action)) {
      const target = args.path || args.dir;
      if (target) {
        const abs = path.isAbsolute(target) ? target : path.resolve(WORKSPACE, target);
        if (args.action === 'delete') {
          extra.diff = { deleted: true, file: abs };
          try {
            if (fs.existsSync(abs)) {
              const lines = fs.readFileSync(abs, 'utf8').split('\n').slice(0, 40);
              extra.diff.preview = lines.map((l) => '- ' + l).join('\n').slice(0, 3000);
              extra.diff.lines = lines.length;
            }
          } catch {}
        } else {
          extra.diff = diffFor(abs, args.content ?? '');
        }
        extra.file = abs;
      }
    }
    if (tool === 'shell' || (tool === 'synthesize_tool' && args.action === 'run')) {
      extra.commandPreview = String(args.command || args.cmd || '').slice(0, 500);
    }
    ctx.emit?.('approval', { ...full, ...extra, args, tool });
  }, { signal: ctx.signal });
  ctx.emit?.('approval_resolved', { id: answer.id, decision: answer.decision, tool, summary: verdict.summary });
  return { allow: answer.decision === 'allow', reason: answer.reason };
}

/* -------------------------------- policy io ------------------------------ */

export function updatePolicy(patch) {
  const cur = settings().policy;
  saveSettings({ policy: { ...cur, ...patch } });
  return settings().policy;
}

export function addRule(match, decision) {
  const rules = [...(settings().policy.rules || []), { match, decision }];
  saveSettings({ policy: { rules } });
  return rules;
}

export function removeRule(match) {
  const rules = (settings().policy.rules || []).filter((r) => r.match !== match);
  saveSettings({ policy: { rules } });
  return rules;
}

export function describe() {
  const p = settings().policy;
  return {
    mode: p.mode,
    modes: MODES,
    rules: p.rules || [],
    checkpoint: p.checkpoint,
    approveTimeoutSec: p.approveTimeoutSec,
    maxStepsPerRun: p.maxStepsPerRun,
    maxToolCallsPerRun: p.maxToolCallsPerRun,
    pending: pendingApprovals(),
    platform: PLATFORM.os,
  };
}
