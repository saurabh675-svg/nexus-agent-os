import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { settings, saveSettings, WORKSPACE, PLATFORM } from './config.js';
import { truncate } from './util.js';

/**
 * Delegation to an external agent CLI.
 *
 * The honest integration seam for "put OpenCode / Hermes / Claude Code on top": do not rewrite the
 * loop, do not vendor another framework. If the user has one of those CLIs installed, hand it a
 * self-contained task and bring the answer back into the same transcript, under the same permission
 * gate.
 *
 * Command syntax differs per tool and changes between releases, so the argv template is data, not
 * code: `settings.delegate.clis` holds {id, command, args} where "{prompt}" is substituted. That way a
 * wrong guess is a settings edit, not a broken build.
 */

const DEFAULTS = [
  { id: 'claude', command: 'claude', args: ['-p', '{prompt}'], note: 'Claude Code print mode (verify flags for your version)' },
  { id: 'codex', command: 'codex', args: ['exec', '{prompt}'], note: 'Codex CLI exec mode' },
  { id: 'opencode', command: 'opencode', args: ['run', '{prompt}'], note: 'OpenCode run mode' },
  { id: 'gemini', command: 'gemini', args: ['-p', '{prompt}'], note: 'Gemini CLI' },
];

export function clis() {
  const cur = settings().delegate?.clis;
  return Array.isArray(cur) && cur.length ? cur : DEFAULTS;
}

export function setClis(list) {
  if (!Array.isArray(list)) throw new Error('clis must be an array');
  saveSettings({ delegate: { clis: list.slice(0, 12) } });
  return clis();
}

function exists(command) {
  const isWin = PLATFORM.os === 'win32';
  // An absolute path is a valid CLI location and must be checked directly, not searched for on PATH.
  if (/[\\/]/.test(command)) {
    const candidates = isWin && !/\.[a-z]{2,4}$/i.test(command) ? [command, command + '.cmd', command + '.exe', command + '.bat'] : [command];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return null;
  }
  const exts = isWin ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(isWin ? ';' : ':')) {
    for (const ext of exts) {
      try {
        const p = dir + (isWin ? '\\' : '/') + command + ext;
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

export function status() {
  const list = clis().map((c) => ({ ...c, found: Boolean(exists(c.command)) }));
  return {
    installed: list.filter((c) => c.found).map((c) => c.id),
    available: list.filter((c) => c.found).length > 0,
    clis: list,
  };
}

export function run({ cli = 'auto', prompt, cwd, timeoutSec = 600 } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('delegate needs a prompt');
  const list = clis();
  const usable = list.filter((c) => exists(c.command));
  if (!usable.length) {
    throw new Error(
      'No external agent CLI found on PATH. Install one (claude / codex / opencode) or point settings.delegate.clis at your own command. Nothing was sent anywhere.',
    );
  }
  const chosen = cli === 'auto' ? usable[0] : list.find((c) => c.id === cli);
  if (!chosen) throw new Error(`unknown cli "${cli}"`);
  if (!exists(chosen.command)) throw new Error(`${chosen.command} is not on PATH`);

  const args = chosen.args.map((a) => String(a).replace('{prompt}', text));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(chosen.command, args, {
      cwd: cwd || WORKSPACE,
      windowsHide: true,
      shell: PLATFORM.os === 'win32',
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, Math.min(timeoutSec, 1800) * 1000);
    child.stdout.on('data', (d) => {
      if (out.length < 200000) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (err.length < 50000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, cli: chosen.id, error: String(e.message || e), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        cli: chosen.id,
        command: `${chosen.command} ${chosen.args.join(' ').replace('{prompt}', '<prompt>')}`,
        code,
        ms: Date.now() - started,
        output: truncate(out.trim(), 12000),
        stderr: truncate(err.trim(), 2000),
      });
    });
  });
}
