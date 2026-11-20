import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, uid, truncate, writeJson } from './util.js';

const FILE = path.join(DATA, 'missions.json');
const MAX_MISSIONS = 40;
const MAX_NODES = 800;
const MAX_MESSAGES = 28;
const MAX_MESSAGE_CHARS = 14000;

const iso = () => new Date().toISOString();

function load() {
  if (!fs.existsSync(FILE)) return { items: {} };
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!parsed || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
    throw new Error('mission store is invalid; inspect data/missions.json before continuing');
  }
  return parsed;
}

function save(store) {
  ensureDir(DATA);
  const items = Object.values(store.items || {});
  const finished = items
    .filter((m) => !['running', 'pausing'].includes(m.status))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const keep = new Set(finished.slice(0, MAX_MISSIONS).map((m) => m.id));
  for (const m of items) {
    if (['running', 'pausing'].includes(m.status) || keep.has(m.id)) keep.add(m.id);
  }
  store.items = Object.fromEntries(items.filter((m) => keep.has(m.id)).map((m) => [m.id, m]));
  writeJson(FILE, store);
  return store;
}

function required(id) {
  const store = load();
  const mission = store.items[id];
  if (!mission) throw new Error(`no such mission: ${id}`);
  return { store, mission };
}

function publicMission(mission, { includeNodes = true } = {}) {
  const { messages, ...visible } = mission;
  if (!includeNodes) delete visible.nodes;
  return structuredClone(visible);
}

function addNode(mission, kind, status, title, detail = '', extra = {}) {
  const node = {
    id: uid('mn_'),
    parentId: mission.nodes.at(-1)?.id || null,
    kind,
    status,
    title: truncate(title || kind, 120),
    detail: truncate(detail, 1200),
    at: iso(),
    ...extra,
  };
  mission.nodes.push(node);
  if (mission.nodes.length > MAX_NODES) {
    mission.nodes.splice(1, mission.nodes.length - MAX_NODES);
    if (mission.nodes[1]) mission.nodes[1].parentId = mission.nodes[0].id;
  }
  return node;
}

function redact(text) {
  return String(text || '')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/--?(?:api-key|token|password|secret)\s+\S+/gi, '[redacted option]');
}

function safeArgs(args = {}) {
  const sensitive = /password|secret|token|api.?key|authorization|cookie/i;
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (sensitive.test(key)) {
      out[key] = '[redacted]';
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string'
        ? truncate(redact(value), 180)
        : value;
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length} items]`;
    } else {
      out[key] = '[object]';
    }
  }
  return out;
}

function snapshotMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: truncate(redact(m.content), MAX_MESSAGE_CHARS),
    }));
}

export function list() {
  return Object.values(load().items)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((mission) => publicMission(mission, { includeNodes: false }));
}

export function get(id) {
  return publicMission(required(id).mission);
}

export function forRun(id) {
  const { mission } = required(id);
  return {
    id: mission.id,
    goal: mission.goal,
    messages: structuredClone(mission.messages || []),
    status: mission.status,
  };
}

export function create({ goal } = {}) {
  const text = String(goal || '').trim();
  if (!text) throw new Error('mission goal is required');
  if (text.length > 6000) throw new Error('mission goal is too long (maximum 6000 characters)');
  const store = load();
  const now = iso();
  const mission = {
    id: uid('ms_'),
    goal: text,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    answer: '',
    error: '',
    messages: [],
    nodes: [],
  };
  addNode(mission, 'goal', 'ready', 'Mission goal', text);
  store.items[mission.id] = mission;
  save(store);
  return publicMission(mission);
}

export function start(id, { acknowledgeRisk = false } = {}) {
  const { store, mission } = required(id);
  const uncertain = mission.nodes.some((node) => node.kind === 'tool' && ['running', 'awaiting_checkpoint', 'indeterminate'].includes(node.status));
  if ((mission.status === 'needs_review' || uncertain) && !acknowledgeRisk) {
    throw new Error('this mission has an action with an unknown outcome; inspect it before explicitly resuming');
  }
  if (!['ready', 'paused', 'failed', 'needs_review'].includes(mission.status)) {
    throw new Error(`cannot start a mission while it is ${mission.status}`);
  }
  mission.status = 'running';
  mission.error = '';
  mission.updatedAt = iso();
  addNode(mission, 'run', 'running', mission.messages.length ? 'Mission resumed' : 'Mission started');
  save(store);
  return publicMission(mission);
}

export function requestPause(id) {
  const { store, mission } = required(id);
  if (mission.status !== 'running') throw new Error(`cannot pause a mission while it is ${mission.status}`);
  mission.status = 'pausing';
  mission.updatedAt = iso();
  addNode(mission, 'run', 'pausing', 'Pause requested');
  save(store);
  return publicMission(mission);
}

export function checkpoint(id, messages) {
  const { store, mission } = required(id);
  mission.messages = snapshotMessages(messages);
  mission.updatedAt = iso();
  for (const node of mission.nodes) {
    if (node.kind === 'tool' && node.status === 'awaiting_checkpoint') {
      node.status = node.resultOk ? 'succeeded' : 'failed';
      delete node.resultOk;
    }
  }
  addNode(mission, 'checkpoint', 'saved', 'Resume checkpoint', `${mission.messages.length} conversation messages saved`);
  save(store);
}

export function recordEvent(id, type, payload = {}) {
  const { store, mission } = required(id);
  let node = null;
  if (type === 'tool_start') {
    const name = String(payload.name || 'tool');
    const args = safeArgs(payload.args);
    node = addNode(mission, 'tool', 'running', name, JSON.stringify(args), {
      callId: String(payload.callId || ''),
    });
  } else if (type === 'tool_end') {
    node = mission.nodes.findLast?.((n) => n.kind === 'tool' && n.callId === String(payload.callId || ''));
    if (node) {
      node.status = 'awaiting_checkpoint';
      node.resultOk = Boolean(payload.ok);
      node.evidence = payload.ok ? 'Tool completed; detailed output remains in the private resume checkpoint.' : 'Tool returned an error; review the final mission response before retrying.';
      node.durationMs = Math.max(0, Number(payload.ms) || 0);
    }
  } else if (type === 'approval') {
    node = addNode(mission, 'approval', 'waiting', `Approval needed: ${payload.tool || 'action'}`, payload.summary || payload.reason, {
      approvalId: String(payload.id || ''),
      risk: String(payload.risk || 'unknown'),
    });
  } else if (type === 'approval_resolved') {
    node = mission.nodes.findLast?.((n) => n.kind === 'approval' && n.approvalId === String(payload.id || ''));
    if (node) {
      node.status = payload.decision === 'allow' ? 'approved' : 'denied';
      node.detail = truncate(`${node.detail} · ${payload.decision || 'resolved'}`, 1200);
    }
  } else if (type === 'answer') {
    mission.answer = truncate(payload.text || '', 8000);
    node = addNode(mission, 'answer', 'complete', 'Agent response', mission.answer);
  } else if (type === 'artifacts') {
    const items = Array.isArray(payload.produced) ? payload.produced : [];
    node = addNode(
      mission,
      'evidence',
      'recorded',
      'Artifact verification',
      `${items.length} artifact(s); ${payload.missing?.length || 0} claimed artifact(s) missing`,
      { artifacts: items.slice(0, 12).map((item) => ({ name: truncate(item.name || '', 120), path: truncate(item.path || '', 240) })) },
    );
  } else if (type === 'error' || type === 'budget') {
    node = addNode(mission, type, type === 'error' ? 'failed' : 'paused', type === 'error' ? 'Run error' : 'Run limit', payload.message || payload.reason || '');
  } else if (type === 'narrative') {
    node = addNode(mission, 'note', 'recorded', 'Agent note', payload.text || '');
  }
  if (node) {
    mission.updatedAt = iso();
    save(store);
    return structuredClone(node);
  }
  return null;
}

export function finish(id, { status, answer, error } = {}) {
  if (!['paused', 'completed', 'failed'].includes(status)) throw new Error(`invalid final mission status: ${status}`);
  const { store, mission } = required(id);
  if (!['running', 'pausing'].includes(mission.status)) throw new Error(`cannot finish a mission while it is ${mission.status}`);
  mission.status = status;
  if (answer !== undefined) mission.answer = truncate(answer, 8000);
  mission.error = error ? truncate(error, 1200) : '';
  mission.updatedAt = iso();
  addNode(mission, 'run', status, status === 'completed' ? 'Mission complete' : status === 'paused' ? 'Mission paused' : 'Mission failed', mission.error || mission.answer);
  save(store);
  return publicMission(mission);
}

export function feedback(id, { rating, note = '' } = {}) {
  const score = Number(rating);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('rating must be an integer from 1 to 5');
  const { store, mission } = required(id);
  if (!['completed', 'failed'].includes(mission.status)) throw new Error('feedback is available after a mission finishes');
  mission.feedback = { rating: score, note: truncate(String(note || '').trim(), 1200), at: iso() };
  mission.updatedAt = iso();
  addNode(mission, 'feedback', 'recorded', `User rating: ${score}/5`, mission.feedback.note || 'No note provided');
  save(store);
  return publicMission(mission);
}

export function lessons(limit = 8) {
  return Object.values(load().items)
    .filter((mission) => mission.feedback?.note && mission.feedback.rating !== 3)
    .sort((a, b) => String(b.feedback.at).localeCompare(String(a.feedback.at)))
    .slice(0, Math.min(20, Math.max(1, Number(limit) || 8)))
    .map((mission) => ({
      rating: mission.feedback.rating,
      note: truncate(mission.feedback.note, 500),
      kind: mission.feedback.rating >= 4 ? 'keep' : 'change',
    }));
}

export function recoverInterrupted() {
  const store = load();
  let changed = false;
  for (const mission of Object.values(store.items)) {
    if (!['running', 'pausing'].includes(mission.status)) continue;
    const uncertain = mission.nodes.some((node) => node.kind === 'tool' && ['running', 'awaiting_checkpoint'].includes(node.status));
    for (const node of mission.nodes) {
      if (node.kind === 'tool' && ['running', 'awaiting_checkpoint'].includes(node.status)) node.status = 'indeterminate';
    }
    mission.status = uncertain ? 'needs_review' : 'paused';
    mission.error = uncertain
      ? 'Nexus restarted during a tool action. Inspect its external effects before explicitly resuming; the action may have completed.'
      : 'Nexus restarted before this mission finished. Resume it to continue from its last checkpoint.';
    mission.updatedAt = iso();
    addNode(mission, 'recovery', mission.status, 'Recovered after restart', mission.error);
    changed = true;
  }
  if (changed) save(store);
  return changed;
}
