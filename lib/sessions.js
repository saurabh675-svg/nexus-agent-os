import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, uid, truncate, readJson, writeJson } from './util.js';

/**
 * Session persistence.
 *
 * A chat is only useful if it survives a reload. Each session is one JSON file so a crash cannot
 * corrupt the others, and the list is read from disk (cheap at this scale) rather than an index file
 * that can drift out of sync.
 */

const DIR = path.join(DATA, 'sessions');

function file(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DIR, `${safe}.json`);
}

export function list(limit = 40, workspaceId) {
  ensureDir(DIR);
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      const sessionWorkspaceId = s.workspaceId || 'default';
      if (workspaceId && sessionWorkspaceId !== workspaceId) continue;
      out.push({
        id: s.id,
        title: s.title || '(untitled)',
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        workspaceId: sessionWorkspaceId,
        messages: Array.isArray(s.messages) ? s.messages.length : 0,
        turns: (s.messages || []).filter((m) => m.role === 'user').length,
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

export function load(id) {
  const s = readJson(file(id), null);
  if (!s) throw new Error('session not found');
  return s;
}

export function create({ title = '', role = 'core', workspaceId = 'default' } = {}) {
  ensureDir(DIR);
  const s = {
    id: uid('s_'),
    title: title || 'new session',
    role,
    workspaceId: String(workspaceId || 'default').slice(0, 64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  writeJson(file(s.id), s);
  return s;
}

/** Upsert. The client owns the message array; this just persists it. */
export function save({ id, title, messages, role, workspaceId }) {
  const prev = (id && readJson(file(id), null)) || create({ title, role, workspaceId });
  const existingWorkspaceId = prev.workspaceId || 'default';
  if (id && workspaceId && existingWorkspaceId !== workspaceId) {
    throw new Error('cannot move a chat session between workspaces');
  }
  const sid = prev.id;
  const firstUser = (messages || []).find((m) => m.role === 'user')?.content || '';
  const s = {
    ...prev,
    id: sid,
    role: role || prev.role || 'core',
    workspaceId: existingWorkspaceId,
    title: title || (prev.title && prev.title !== 'new session' ? prev.title : '') || truncate(String(firstUser).replace(/\s+/g, ' '), 70) || 'new session',
    updatedAt: new Date().toISOString(),
    messages: (messages || []).slice(-200),
  };
  writeJson(file(sid), s);
  return { id: sid, title: s.title, messages: s.messages.length, updatedAt: s.updatedAt };
}

export function rename(id, title) {
  const s = load(id);
  s.title = String(title || s.title).slice(0, 120);
  s.updatedAt = new Date().toISOString();
  writeJson(file(id), s);
  return s;
}

export function remove(id) {
  try {
    fs.unlinkSync(file(id));
    return { removed: id };
  } catch {
    throw new Error('session not found');
  }
}

export function search(q, limit = 20) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return list(limit);
  return list(200).filter((s) => s.title.toLowerCase().includes(needle)).slice(0, limit);
}
