import { spawn } from 'node:child_process';
import { settings, saveSettings, PLATFORM } from './config.js';

/**
 * User hooks: shell commands around tool calls, in the shape Claude Code users expect.
 *
 * preTool runs BEFORE a tool; a non-zero exit blocks the call (fail closed). postTool runs after and
 * can only observe. Every hook gets a JSON payload on stdin and the same JSON in $NEXUS_HOOK.
 * A hook that times out blocks the pre-hook (again: fail closed) — silence must not mean consent.
 */

const DEFAULT_TIMEOUT = 8000;

export function get() {
  const h = settings().hooks || {};
  return { preTool: h.preTool || [], postTool: h.postTool || [], enabled: h.enabled !== false };
}

export function set(patch = {}) {
  const cur = get();
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
    preTool: Array.isArray(patch.preTool) ? patch.preTool.slice(0, 10) : cur.preTool,
    postTool: Array.isArray(patch.postTool) ? patch.postTool.slice(0, 10) : cur.postTool,
  };
  saveSettings({ hooks: next });
  return next;
}

function runOne(command, payload, timeoutMs) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'powershell.exe' : 'bash';
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: PLATFORM.home || process.cwd(),
        windowsHide: true,
        env: { ...process.env, NEXUS_HOOK: JSON.stringify(payload).slice(0, 4000) },
      });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: String(e.message || e) });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      try {
        if (isWin && child.pid) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, code: -1, stdout: stdout.slice(0, 2000), stderr: 'hook timed out' });
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      if (stdout.length < 20000) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < 8000) stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout, stderr: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) });
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {}
  });
}

/** Returns { block, reason, results } — block:true means the tool must not run. */
export async function pre(tool, args) {
  const h = get();
  if (!h.enabled || !h.preTool.length) return { block: false, results: [] };
  const payload = { hook: 'preTool', tool, args, at: new Date().toISOString() };
  const results = [];
  for (const command of h.preTool) {
    const r = await runOne(command, payload, DEFAULT_TIMEOUT);
    results.push({ command, ...r });
    if (!r.ok) {
      return {
        block: true,
        reason: `preTool hook refused: ${command} → ${(r.stderr || r.stdout || 'exit ' + r.code).slice(0, 200)}`,
        results,
      };
    }
  }
  return { block: false, results };
}

export async function post(tool, args, result, ms) {
  const h = get();
  if (!h.enabled || !h.postTool.length) return [];
  const payload = {
    hook: 'postTool',
    tool,
    args,
    ms,
    ok: result?.ok !== false,
    resultPreview: JSON.stringify(result ?? null).slice(0, 1500),
    at: new Date().toISOString(),
  };
  const results = [];
  for (const command of h.postTool) results.push({ command, ...(await runOne(command, payload, DEFAULT_TIMEOUT)) });
  return results;
}
