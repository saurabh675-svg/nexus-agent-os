/**
 * Spatial Thought Workspaces — goal-bound cognitive desktops (Phase 2)
 * Each workspace holds a high-level goal, preferred tools/skills, open context notes,
 * and an optional system overlay that hot-swaps into the agent prompt when active.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, uid } from './util.js';

const FILE = path.join(DATA, 'workspaces.json');

const DEFAULTS = [
  {
    id: 'default',
    name: 'General',
    goal: 'General work and exploration',
    color: '#6ee7b7',
    systemOverlay: '',
    skills: [],
    notes: [],
    pinnedApps: ['chat', 'browser', 'terminal'],
  },
  {
    id: 'research',
    name: 'Research',
    goal: 'Deep research with primary sources and citations',
    color: '#60a5fa',
    systemOverlay:
      'You are in the Research workspace. Prefer web_search, open_page, browser. Cite URLs. Prefer primary sources. Never invent a URL.',
    skills: ['deep-research', 'research-brief'],
    notes: [],
    pinnedApps: ['chat', 'search', 'browser', 'memory'],
  },
  {
    id: 'kaggle',
    name: 'Kaggle / Competitions',
    goal: 'Competition deadlines, kernels, datasets',
    color: '#fbbf24',
    systemOverlay:
      'You are in the Global Intelligence workspace with a competition focus. Check official rules, datasets, reproducible baselines, validation, and compliant submissions. Compare relevant grants, research calls, and paid alternatives when useful. Never submit without explicit approval.',
    skills: ['kaggle-runner', 'work-kaggle-supervision'],
    notes: [],
    pinnedApps: ['chat', 'radar', 'browser', 'lab', 'missions'],
  },
  {
    id: 'business',
    name: 'Business Opportunities',
    goal: 'Evaluate business ideas and practical earning opportunities',
    color: '#34d399',
    systemOverlay:
      'You are in the Global Intelligence workspace with an earning and business focus. Compare customer demand, competition, grants and public support, conservative unit economics, downside, and low-cost validation. Consider Kaggle, research calls, contracts, and other legitimate alternatives when relevant. Cite current evidence and never promise income or returns.',
    skills: ['business-opportunity-review'],
    notes: [],
    pinnedApps: ['chat', 'radar', 'browser', 'lab', 'missions', 'search'],
  },
  {
    id: 'dev',
    name: 'Web / App Dev',
    goal: 'Coding, previews, guarded terminal, decks',
    color: '#c084fc',
    systemOverlay:
      'You are in the Dev workspace. Prefer files, terminal, preview, decks. Keep changes inside the workspace. Verify claims against disk.',
    skills: ['file-ops', 'office-docs', 'pptx'],
    notes: [],
    pinnedApps: ['chat', 'terminal', 'files', 'decks'],
  },
];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw?.workspaces?.length) {
      const saved = raw.workspaces.filter((workspace) => workspace && typeof workspace.id === 'string');
      const savedById = new Map(saved.map((workspace) => [workspace.id, workspace]));
      const defaults = DEFAULTS.map((workspace) => ({
        ...workspace,
        ...(savedById.get(workspace.id) || {}),
      }));
      const oldKaggleOverlay = 'Keep business-opportunity and general-chat work out of this workspace.';
      const oldBusinessOverlay = 'Keep Kaggle competition work separate.';
      const kaggle = defaults.find((workspace) => workspace.id === 'kaggle');
      const business = defaults.find((workspace) => workspace.id === 'business');
      if (kaggle && kaggle.systemOverlay.includes(oldKaggleOverlay)) {
        const current = DEFAULTS.find((workspace) => workspace.id === 'kaggle');
        kaggle.systemOverlay = current.systemOverlay;
        if (JSON.stringify(kaggle.pinnedApps) === JSON.stringify(['chat', 'kaggle', 'lab', 'terminal'])) kaggle.pinnedApps = current.pinnedApps;
      }
      if (business && business.systemOverlay.includes(oldBusinessOverlay)) {
        const current = DEFAULTS.find((workspace) => workspace.id === 'business');
        business.systemOverlay = current.systemOverlay;
        if (JSON.stringify(business.pinnedApps) === JSON.stringify(['chat', 'intel', 'radar', 'missions', 'search'])) business.pinnedApps = current.pinnedApps;
      }
      const defaultIds = new Set(DEFAULTS.map((workspace) => workspace.id));
      const custom = saved.filter((workspace) => !defaultIds.has(workspace.id));
      const workspaces = [...defaults, ...custom];
      const activeId = workspaces.some((workspace) => workspace.id === raw.activeId) ? raw.activeId : 'default';
      return { ...raw, activeId, workspaces };
    }
  } catch {}
  return { activeId: 'default', workspaces: DEFAULTS };
}

function save(state) {
  ensureDir(DATA);
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function list() {
  const s = load();
  return { activeId: s.activeId, workspaces: s.workspaces };
}

export function getActive() {
  const s = load();
  return s.workspaces.find((w) => w.id === s.activeId) || s.workspaces[0];
}

export function setActive(id) {
  const s = load();
  if (!s.workspaces.find((w) => w.id === id)) throw new Error('unknown workspace');
  s.activeId = id;
  save(s);
  return getActive();
}

export function upsert(ws) {
  const s = load();
  const id = String(ws.id || ws.name || uid())
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 48);
  const body = {
    id,
    name: ws.name || id,
    goal: ws.goal || '',
    color: ws.color || '#6ee7b7',
    systemOverlay: ws.systemOverlay || '',
    skills: ws.skills || [],
    notes: ws.notes || [],
    pinnedApps: ws.pinnedApps || ['chat'],
  };
  const i = s.workspaces.findIndex((w) => w.id === id);
  if (i >= 0) s.workspaces[i] = { ...s.workspaces[i], ...body };
  else s.workspaces.push(body);
  save(s);
  return body;
}

export function remove(id) {
  if (id === 'default') throw new Error('cannot remove default workspace');
  const s = load();
  s.workspaces = s.workspaces.filter((w) => w.id !== id);
  if (s.activeId === id) s.activeId = 'default';
  save(s);
  return { ok: true };
}

/** Overlay text injected into the agent system prompt when this workspace is active */
export function activeOverlay() {
  const w = getActive();
  if (!w) return '';
  const parts = [];
  if (w.goal) parts.push(`Active workspace goal: ${w.goal}`);
  if (w.systemOverlay) parts.push(w.systemOverlay);
  if (w.notes?.length) parts.push('Workspace notes:\n' + w.notes.slice(-8).map((n) => `- ${n}`).join('\n'));
  return parts.join('\n\n');
}
