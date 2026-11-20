import fs from 'node:fs';
import path from 'node:path';
import { settings, saveSettings, WORKSPACE } from './config.js';
import { truncate } from './util.js';

/**
 * Project context.
 *
 * Claude Code keeps memory in CLAUDE.md / AGENTS.md; this reads the same files (plus NEXUS.md) from the
 * selected project folder and injects them. Root is found by walking up, because you usually open a
 * subfolder and the instructions live at the repo root.
 */

const NAMES = ['NEXUS.md', 'AGENTS.md', 'CLAUDE.md', '.nexus/memory.md'];
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'kernel-metadata.json'];

export function currentDir() {
  return settings().projectDir || WORKSPACE;
}

export function findRoot(start) {
  let dir = path.resolve(start || currentDir());
  for (let i = 0; i < 6; i++) {
    try {
      const hasMarker = MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
      const hasInstructions = NAMES.some((n) => fs.existsSync(path.join(dir, n)));
      if (hasMarker || hasInstructions) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start || currentDir());
}

export function load(dir) {
  const target = path.resolve(dir || currentDir());
  const root = findRoot(target);
  const files = [];
  for (const name of NAMES) {
    const file = path.join(root, name);
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      files.push({ name, chars: text.length, text });
    } catch {}
  }
  const merged = files.map((f) => `### ${f.name}\n${f.text.trim()}`).join('\n\n');
  return {
    dir: target,
    root,
    exists: fs.existsSync(target),
    files: files.map((f) => ({ name: f.name, chars: f.chars })),
    text: truncate(merged, 3500),
    chars: merged.length,
  };
}

export function setDir(dir) {
  const target = path.resolve(String(dir || ''));
  if (!fs.existsSync(target)) throw new Error(`folder does not exist: ${target}`);
  if (!fs.statSync(target).isDirectory()) throw new Error('that path is a file, not a folder');
  saveSettings({ projectDir: target });
  return load(target);
}

/** Append a line to the project's own memory file — this is the "auto memory" Claude documents. */
export function remember(dir, line) {
  const root = findRoot(dir);
  const file = path.join(root, '.nexus', 'memory.md');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(file, `- ${stamp}: ${String(line).replace(/\s+/g, ' ').slice(0, 300)}\n`, 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
