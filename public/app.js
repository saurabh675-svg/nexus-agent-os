import { streamPost, panelPoll } from './workspace-runtime.js';

/* Nexus — local agent OS. Zero dependencies, talks to the Node server over fetch + SSE. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return n;
}
const clear = (n) => {
  while (n.firstChild) n.removeChild(n.firstChild);
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function md(t) {
  let s = esc(t);
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/^#{1,3}\s+(.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, (m) => `<ul>${m}</ul>`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s
    .split(/\n{2,}/)
    .map((p) => (/^<(ul|pre|h3)/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('');
}

/* --------------------------------- state --------------------------------- */
const state = { settings: null, models: { models: [] }, skills: [], roles: [], tasks: [], browser: {}, tools: [] };
const chatContexts = new Map();
let activeWorkspaceId = 'default';
let chatMode = 'agent';

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function ssePost(path, payload, on, signal) {
  return streamPost(path, payload, on, signal);
}

function toast(text, kind = '') {
  const t = el('div', 'toast ' + kind, text);
  $('#toasts').append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(14px)';
    setTimeout(() => t.remove(), 220);
  }, kind === 'err' ? 6500 : 3800);
}

/* --------------------------------- icons --------------------------------- */
const ICONS = {
  chat: '<path d="M4 5.5h16v10.5H9l-5 4z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  browser: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3.2 3.5 3.2 13.5 0 17M12 3.5c-3.2 3.5-3.2 13.5 0 17"/>',
  agents: '<circle cx="12" cy="4.6" r="2.3"/><circle cx="5" cy="18.4" r="2.3"/><circle cx="19" cy="18.4" r="2.3"/><path d="M10.6 6.7l-4.2 9.4M13.4 6.7l4.2 9.4M7.3 18.4h9.4"/>',
  missions: '<path d="M19.2 8.5A7.8 7.8 0 104 15.8"/><path d="M19.2 3.8v4.8h-4.8M4.8 15.5v4.8h4.8"/>',
  tasks: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3.3 2"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.6 7l8.4 6 8.4-6"/>',
  kaggle: '<path d="M8.5 4v16M8.5 13.5L16 6.5M8.5 13.5L16.5 20"/>',
  skills: '<path d="M12 3.2l1.9 5.2 5.2 1.9-5.2 1.9L12 17.4l-1.9-5.2L4.9 10.3l5.2-1.9z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l2.6 2L7 14M12.6 14.6h4"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9"/>',
  files: '<path d="M3.5 7.6c0-1.1.9-2 2-2h3.6l2 2.4h7.4c1.1 0 2 .9 2 2v7.4c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2z"/>',
  settings: '<path d="M3.5 7h8.6M16.6 7h3.9M3.5 12h3M11 12h9.5M3.5 17h7M14.6 17h5.9"/><circle cx="14.3" cy="7" r="1.9"/><circle cx="8.7" cy="12" r="1.9"/><circle cx="12.3" cy="17" r="1.9"/>',
  doctor: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.4v7.2M8.4 12h7.2"/>',
  safety: '<path d="M12 3.2l7 2.8v6c0 4.2-3 7.3-7 8.8-4-1.5-7-4.6-7-8.8v-6z"/><path d="M9 12l2 2 4-4"/>',
  vault: '<rect x="4" y="9.5" width="16" height="10.5" rx="2.5"/><path d="M8 9.5V7a4 4 0 018 0v2.5M12 14v2"/>',
  community: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M15 14.2c2.6.2 4.5 2 4.5 4.8"/>',
  brain: '<path d="M12 4.5c-2.2-1.6-5-1.2-6.6.6-1.3 1.5-1.4 3.4-.6 5-.9 1.6-.7 3.6.6 4.9 1.5 1.7 4.1 2 6.6.5 2.5 1.5 5.1 1.2 6.6-.5 1.3-1.3 1.5-3.3.6-4.9.8-1.6.7-3.5-.6-5-1.6-1.8-4.4-2.2-6.6-.6z"/><path d="M12 4.5v15M8.2 8.5c1.3.6 2.5 1.5 3.8 2.4M8.2 15.5c1.3-.6 2.5-1.5 3.8-2.4M15.8 8.5c-1.3.6-2.5 1.5-3.8 2.4M15.8 15.5c-1.3-.6-2.5-1.5-3.8-2.4"/>',
  intel: '<path d="M12 3.4l8.5 5v11.2l-8.5-5z"/><path d="M12 3.4l-8.5 5v11.2l8.5-5z"/><path d="M3.5 8.4l8.5-5 8.5 5"/>',
  lab: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 4.5v5M8 14.5h5M8 17.5h8"/>',
  radar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4"/>',
  viewer: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M9 9v10.5"/>',
  providers: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  appearance: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" opacity="0.35"/>',
  connect: '<circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M10 12h4"/>',
  work: '<path d="M4 9.5l8-5 8 5v10a1 1 0 01-1 1H5a1 1 0 01-1-1z"/><path d="M9.5 20.5v-6h5v6"/>',
  apps: '<rect x="3.5" y="4.5" width="7" height="6.5" rx="1.5"/><rect x="13" y="4.5" width="7" height="6.5" rx="1.5"/><rect x="3.5" y="13" width="7" height="6.5" rx="1.5"/><rect x="13" y="13" width="7" height="6.5" rx="1.5"/>',
  deck: '<rect x="3.5" y="4" width="17" height="11" rx="2"/><path d="M12 8v4M9 9.5L12 8l3 1.5M8 19.5h8M12 15v4.5"/>',
  grid: '<rect x="3.6" y="3.6" width="4.8" height="4.8" rx="1.2"/><rect x="9.6" y="3.6" width="4.8" height="4.8" rx="1.2"/><rect x="15.6" y="3.6" width="4.8" height="4.8" rx="1.2"/><rect x="3.6" y="9.6" width="4.8" height="4.8" rx="1.2"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1.2"/><rect x="15.6" y="9.6" width="4.8" height="4.8" rx="1.2"/><rect x="3.6" y="15.6" width="4.8" height="4.8" rx="1.2"/><rect x="9.6" y="15.6" width="4.8" height="4.8" rx="1.2"/><rect x="15.6" y="15.6" width="4.8" height="4.8" rx="1.2"/>',
};
const GLYPH_ICON = {
  '⌕': 'search',
  '◐': 'browser',
  '⬡': 'agents',
  '⟳': 'missions',
  '◷': 'tasks',
  '✉': 'mail',
  K: 'kaggle',
  '✦': 'skills',
  '▮': 'terminal',
  '❖': 'memory',
  '▤': 'files',
  '⚙': 'settings',
  '✚': 'doctor',
  '⛨': 'safety',
  '⛁': 'vault',
  '◉': 'community',
  '❋': 'brain',
  '◭': 'intel',
  '▦': 'lab',
  '◬': 'radar',
  '◱': 'viewer',
  '⇄': 'providers',
  '◑': 'appearance',
  '⊛': 'connect',
  '⌂': 'work',
  '▩': 'apps',
  '◈': 'chat',
};
const svg = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.chat}</svg>`;

/* ----------------------------- window manager ---------------------------- */
const apps = new Map();
const wins = new Map();
let zTop = 100;

function registerApp(def) {
  apps.set(def.id, def);
}

function openApp(id, arg) {
  if (id === 'kaggle' || id === 'intel') {
    arg = { tab: id === 'kaggle' ? 'kaggle' : 'business' };
    id = 'radar';
  }
  if (id === 'providers') id = 'connect';
  const def = apps.get(id);
  if (!def) return;
  let win = wins.get(id);
  if (win && win.el.style.display !== 'none') {
    focusWin(win);
    activateWorkspace(id);
    if (arg && def.onArg) def.onArg(win, arg);
    return;
  }
  if (!win) {
    const [w, h] = def.size || [720, 540];
    const offset = (wins.size % 6) * 24;
    const cw = $('#windows').clientWidth;
    const ch = $('#windows').clientHeight;
    const node = el('div', 'win focused');
    node.style.width = Math.min(w, cw - 40) + 'px';
    node.style.height = Math.min(h, ch - 24) + 'px';
    node.style.left = Math.max(12, Math.round((cw - Math.min(w, cw - 40)) / 2) + offset - 48) + 'px';
    node.style.top = Math.max(6, Math.round((ch - Math.min(h, ch - 24)) / 2) + offset - 52) + 'px';
    node.style.zIndex = ++zTop;

    const bar = el('div', 'win-bar');
    const dots = el('div', 'dots');
    const bClose = el('button', 'dot close');
    const bMin = el('button', 'dot min');
    const bMax = el('button', 'dot max');
    bClose.title = 'close';
    bMin.title = 'minimise';
    bMax.title = 'maximise';
    dots.append(bClose, bMin, bMax);
    const title = el('div', 'win-title', el('span', 'glyph', def.glyph || '◈'), def.title);
    const actions = el('div', 'win-actions');
    bar.append(dots, title, actions);
    const body = el('div', 'win-body');
    node.append(bar, body);
    $('#windows').append(node);

    bClose.onclick = () => closeWin(id);
    bMin.onclick = () => {
      if (document.body.dataset.layout === 'focus') return openApp('chat');
      node.style.display = 'none';
      syncDock();
    };
    bMax.onclick = () => node.classList.toggle('max');
    bar.addEventListener('pointerdown', (e) => dragWin(e, node, bar));
    node.addEventListener('pointerdown', () => focusWin(win), true);

    win = { id, el: node, body, titleEl: title, actions, focused: true, render: def.render };
    wins.set(id, win);
    node.dataset.app = id;
    Promise.resolve(def.render(body, win)).catch(e => toast(e.message || 'Panel could not load', 'err'));
  } else {
    win.el.style.display = 'flex';
    focusWin(win);
  }
  if (arg && apps.get(id).onArg) apps.get(id).onArg(win, arg);
  activateWorkspace(id);
  syncDock();
}

function focusWin(win) {
  if (!win) return;
  for (const [, w] of wins) {
    w.el.classList.remove('focused');
    w.focused = false;
  }
  win.el.classList.add('focused');
  win.el.style.zIndex = ++zTop;
  win.focused = true;
}

function closeWin(id) {
  const win = wins.get(id);
  if (!win) return;
  if (win.busy) return toast('This task is running. Use Stop in the chat before closing it.', 'warn');
  win.body.dispatchEvent(new Event('nexus-dispose'));
  win.el.remove();
  wins.delete(id);
  if (document.body.dataset.layout === 'focus' && id !== 'chat') openApp('chat');
  syncDock();
}

function dragWin(e, node, bar) {
  if (e.target.closest('button')) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const left = parseFloat(node.style.left) || 0;
  const top = parseFloat(node.style.top) || 0;
  const move = (ev) => {
    if (node.classList.contains('max')) return;
    node.style.left = Math.max(-40, left + ev.clientX - startX) + 'px';
    node.style.top = Math.max(-10, top + ev.clientY - startY) + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function syncDock() {
  $$('.dock-item').forEach((b) => {
    const w = wins.get(b.dataset.app);
    b.classList.toggle('active', Boolean(w && w.el.style.display !== 'none'));
  });
}

/* ------------------------------- chat app -------------------------------- */
function renderChat(body, win) {
  clear(body);
  const workspaceId = win.chatWorkspaceId || activeWorkspaceId;
  win.chatWorkspaceId = workspaceId;
  const renderRevision = (win.chatRenderRevision || 0) + 1;
  win.chatRenderRevision = renderRevision;
  const hadSavedContext = chatContexts.has(workspaceId);
  const savedContext = chatContexts.get(workspaceId) || {};
  let chatHistory = [...(savedContext.messages || [])];
  let sessionId = savedContext.sessionId || null;
  const shell = el('div', 'chat-shell');
  const bar = el('div', 'chat-toolbar');

  const seg = el('div', 'seg');
  const bAgent = el('button', chatMode === 'agent' ? 'active' : '', 'Agent');
  const bChat = el('button', chatMode === 'chat' ? 'active' : '', 'Chat');
  seg.append(bAgent, bChat);
  bAgent.onclick = () => {
    chatMode = 'agent';
    bAgent.classList.add('active');
    bChat.classList.remove('active');
  };
  bChat.onclick = () => {
    chatMode = 'chat';
    bChat.classList.add('active');
    bAgent.classList.remove('active');
  };

  const roleSel = el('select');
  roleSel.style.width = 'auto';
  roleSel.style.padding = '4px 6px';
  roleSel.style.fontSize = '11px';
  const roles = state.roles.length ? state.roles : [{ id: 'core', name: 'Nexus' }];
  for (const r of roles) {
    const o = el('option', '', r.name);
    o.value = r.id;
    roleSel.append(o);
  }
  const preferredRole = savedContext.role || (workspaceId === 'business' ? 'business_analyst' : workspaceId === 'research' ? 'researcher' : 'core');
  roleSel.value = roles.some((r) => r.id === preferredRole) ? preferredRole : 'core';
  roleSel.setAttribute('aria-label', 'Assistant role');
  roleSel.onchange = () => {
    win.role = roleSel.value;
    chatContexts.set(workspaceId, { ...chatContexts.get(workspaceId), role: roleSel.value });
  };
  win.refreshState = () => {
    const selected = roleSel.value;
    const roles = state.roles.length ? state.roles : [{ id: 'core', name: 'Nexus' }];
    if ([...roleSel.options].map(o=>o.value).join() !== roles.map(r=>r.id).join()) {
      clear(roleSel);
      for (const r of roles) { const option = el('option','',r.name); option.value = r.id; roleSel.append(option); }
      if (roles.some(r=>r.id===selected)) roleSel.value = selected;
    }
    modePill.textContent = 'Permissions · ' + (state.policy?.mode || 'ask');
  };

  const bCluster = el('button', 'btn sm ghost', '⬡ cluster');
  bCluster.onclick = () => openApp('agents', $('#chat-input')?.value || '');
  const modePill = el('button', 'pill', 'mode · ' + (state.policy?.mode || 'ask'));
  modePill.title = 'Permission mode';
  modePill.onclick = () => openApp('safety');
  const bClear = el('button', 'btn sm ghost', 'clear');
  const bHistory = el('button', 'btn sm ghost', '⌸ history');
  bHistory.title = 'resume a previous conversation';
  bHistory.onclick = async () => {
    const r = await api('/api/sessions?workspaceId=' + encodeURIComponent(workspaceId));
    if (win.chatRenderRevision !== renderRevision) return;
    const panel = el('div', 'card');
    panel.append(el('div', 'small faint', `${(r.items || []).length} saved session(s) — click to resume`));
    for (const s of (r.items || []).slice(0, 25)) {
      const row = el('div', 'filerow');
      const open = el('button', 'btn sm', 'resume');
      open.onclick = async () => {
        if (win.busy) return toast('Stop the current task before resuming a chat.', 'warn');
        ++sessionRevision;
        const full = await api('/api/sessions/' + s.id);
        if (win.chatRenderRevision !== renderRevision) return;
        if (!full.ok) return toast(full.error || 'failed', 'err');
        if ((full.session.workspaceId || 'default') !== workspaceId) return toast('That chat belongs to another workspace.', 'err');
        sessionId = full.session.id;
        chatHistory = (full.session.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
        roleSel.value = roles.some((r) => r.id === full.session.role) ? full.session.role : 'core';
        chatContexts.set(workspaceId, { sessionId, messages: chatHistory, role: roleSel.value });
        clear(log);
        for (const m of chatHistory) addMsg(m.role === 'user' ? 'user' : 'agent', m.content);
        toast(`resumed “${full.session.title}” · ${chatHistory.length} messages`);
        panel.remove();
      };
      row.append(el('span', 'grow ellipsis small', s.title), el('span', 'faint small', `${s.turns} turns · ${String(s.updatedAt).slice(0, 16).replace('T', ' ')}`), open);
      panel.append(row);
    }
    log.append(panel);
    scrollDown();
  };
  bClear.onclick = async () => {
    if (win.busy) return toast('Stop the current task before starting a new chat.', 'warn');
    ++sessionRevision;
    send.disabled = true;
    win.busy = true;
    await persist();
    send.disabled = false;
    win.busy = false;
    sessionId = null;
    win.sessionId = null;
    chatHistory = [];
    chatContexts.set(workspaceId, { sessionId: null, messages: [], role: roleSel.value });
    log.innerHTML = '';
    greeting();
  };

  const bHandoff = el('button', 'btn sm ghost', '⇥ handoff');
  bHandoff.title = 'write a handoff note into the project’s .nexus\\memory.md and start a clean session';
  bHandoff.onclick = async () => {
    const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user')?.content || '';
    const lastAgent = [...chatHistory].reverse().find((m) => m.role === 'assistant')?.content || '';
    if (!lastUser) return toast('nothing to hand off yet', 'warn');
    const note = `goal: ${lastUser.replace(/\s+/g, ' ').slice(0, 160)} | outcome: ${lastAgent.replace(/\s+/g, ' ').slice(0, 220)}`;
    const r = await api('/api/handoff', { note, title: lastUser.replace(/\s+/g, ' ').slice(0, 60), workspaceId });
    if (win.chatRenderRevision !== renderRevision) return;
    if (!r.ok) return toast(r.error || 'failed', 'err');
    sessionId = r.session.id;
    chatContexts.set(workspaceId, { sessionId, messages: [], role: roleSel.value });
    ++sessionRevision;
    chatHistory = [];
    clear(log);
    greeting();
    toast('handoff written to project memory · clean session started');
  };

  const options = el('details', 'chat-options');
  const roleControl = el('label', 'small muted', 'Assistant role', roleSel);
  const optionsMenu = el('div', 'chat-options-menu', roleControl, bCluster, bHandoff, bHistory, bClear);
  options.append(el('summary', '', 'Options'), optionsMenu);
  bar.append(seg, modePill, el('span', 'grow'), options);

  const projPill = el('button', 'pill', 'project');
  projPill.title = 'project folder — AGENTS.md / CLAUDE.md / NEXUS.md get injected into every prompt';
  api('/api/project')
    .then((p) => {
      projPill.textContent = 'project · ' + String(p.root || '').split(/[\\/]/).pop();
      projPill.title = p.root + (p.files?.length ? `  (${p.files.map((f) => f.name).join(', ')})` : '  (no instruction file)');
      projPill.classList.toggle('warn', !(p.files || []).length);
    })
    .catch(() => {});
  projPill.onclick = async () => {
    const dir = prompt('Project folder — instructions from AGENTS.md / CLAUDE.md / NEXUS.md will be read', '');
    if (!dir) return;
    const r = await api('/api/project', { dir });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    projPill.textContent = 'project · ' + String(r.root).split(/[\\/]/).pop();
    projPill.classList.toggle('warn', !(r.files || []).length);
    toast('project set · ' + ((r.files || []).map((f) => f.name).join(', ') || 'no instruction file found'));
  };
  bar.insertBefore(projPill, modePill);

  const log = el('div', 'chat-log');
  const composer = el('div', 'composer');
  const chips = el('div', 'row wrap attach-row');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  const attach = el('button', 'btn sm ghost attach-btn', '+ file');
  attach.title = 'attach up to 10 files (25 MB each) — or drag them anywhere onto this window';
  attach.onclick = () => fileInput.click();
  const box = el('div', 'composer-box');
  const ta = el('textarea');
  ta.id = 'chat-input';
  ta.rows = 1;
  ta.placeholder = 'Ask Nexus anything or give it a task…';
  const send = el('button', 'send', '↑');
  const stop = el('button', 'send stop', '⏹');
  stop.title = 'stop this run (Esc)';
  stop.style.display = 'none';
  box.append(attach, ta, send, stop);
  const hint = el('div', 'chat-hint', el('span', '', '⏎ send'), el('span', '', 'Ctrl+K jump'), el('span', '', 'drop files to attach'), el('span', '', 'general Nexus chat'));
  composer.append(chips, box, hint, fileInput);
  shell.append(bar, log, composer);
  body.append(shell);

  let attachments = [];
  let sessionRevision = 0;
  win.newChat = () => bClear.click();
  win.showHistory = () => bHistory.click();
  win.persistChat = persist;

  const SLASH = {
    plan: 'Give me a step-by-step plan with checks for: ',
    research: 'Research this properly with sources and a confidence level: ',
    deck: 'Build a PowerPoint deck for: ',
    doc: 'Write a Word document for: ',
    sheet: 'Work with a spreadsheet for: ',
    fix: 'Find the cause and fix it: ',
    brief: 'Write a one-page brief on: ',
  };

  async function persist() {
    chatContexts.set(workspaceId, { sessionId, messages: [...chatHistory], role: roleSel.value });
    if (!chatHistory.length) return;
    const revision = sessionRevision;
    try {
      const r = await api('/api/sessions', { action: 'save', id: sessionId || undefined, workspaceId, messages: chatHistory, role: roleSel.value });
      if (r.ok && r.id && revision === sessionRevision) {
        sessionId = r.id;
        win.sessionId = r.id;
        chatContexts.set(workspaceId, { sessionId, messages: [...chatHistory], role: roleSel.value });
      }
    } catch {}
  }
  function renderChips() {
    clear(chips);
    for (const a of attachments) {
      const c = el('span', 'chipfile', `${a.name} · ${(a.bytes / 1024).toFixed(0)}KB`);
      const x = el('button', 'tab-x', '×');
      x.onclick = () => {
        attachments = attachments.filter((v) => v.id !== a.id);
        renderChips();
      };
      c.append(x);
      chips.append(c);
    }
    if (attachments.length) chips.append(el('span', 'faint small', `${attachments.length}/10 attached`));
  }

  async function addFiles(list) {
    const room = 10 - attachments.length;
    const files = [...list].slice(0, room);
    if (list.length > room) toast(`only ${room} more file(s) fit — limit is 10 per message`, 'warn');
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) {
        toast(`${f.name} is over 25 MB`, 'err');
        continue;
      }
      const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: f,
      })
        .then((x) => x.json())
        .catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) {
        toast(r.error || 'upload failed', 'err');
        continue;
      }
      attachments.push(r.file);
    }
    renderChips();
  }
  fileInput.onchange = () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  };
  shell.addEventListener('dragover', (e) => e.preventDefault());
  shell.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  const scrollDown = () => {
    if (nearBottom()) log.scrollTop = log.scrollHeight;
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 140;

  function greeting() {
    const welcome = el('section', 'workspace-welcome');
    welcome.append(
      el('div', 'welcome-mark', '◈'),
      el('h1', '', 'One agent. A wider opportunity map.'),
      el('p', '', 'Ask Nexus to research globally, compare evidence, build a plan, or create code. It shows sources, uncertainty, costs, and the next practical action.'),
    );
    const grid = el('div', 'workspace-suggestions');
    for (const [icon, label, detail, prompt] of [
      ['search', 'Find opportunities I missed', 'Grants, contracts, competitions, schemes', 'Search globally for current opportunities that fit my skills and location. Include grants, government support, research challenges, paid work, competitions, and less-obvious alternatives. Verify official sources, eligibility, deadlines, costs, and the smallest next step. Do not promise income.'],
      ['kaggle', 'Evaluate a Kaggle challenge', 'Rules, data, baseline, effort', 'Research this Kaggle competition from its official rules and data. Estimate effort and upside, find permitted public prior work, and propose a reproducible baseline and validation plan. Do not submit anything without approval.'],
      ['intel', 'Check business and public support', 'Demand, grants, downside, validation', 'Research a practical business opportunity in my region and globally. Check customer demand, competitors, grants and government schemes from official sources, setup requirements, costs, risks, and a low-cost validation step.'],
      ['terminal', 'Build a GEE + Python pipeline', 'Earth Engine, geospatial data, reproducibility', 'Help me design and build a geospatial analysis pipeline with Google Earth Engine and Python. First research suitable datasets and official documentation, then produce reproducible code, validation checks, export steps, and setup instructions.'],
      ['deck', 'Get a useful world briefing', 'AI, business, science, policy, climate', 'Give me a cited global briefing on recent developments in AI, business, science, public funding, climate, and geospatial technology. Prioritize changes that could affect career, research, or earning opportunities; separate facts from analysis.'],
    ]) {
      const b = el('button', 'welcome-task'); const symbol = el('span','welcome-task-icon'); symbol.innerHTML = svg(icon);
      b.append(symbol, el('strong','',label), el('span','',detail));
      b.onclick = () => { ta.value = prompt; ta.dispatchEvent(new Event('input')); ta.focus(); };
      grid.append(b);
    }
    const shortcuts = el('div', 'row wrap');
    for (const [label, app] of [
      ['Open Global Intelligence', 'radar'],
      ['Browser', 'browser'],
      ['Gmail', 'mail'],
      ['Google Drive', 'drive'],
      ['Geospatial Lab', 'lab'],
    ]) {
      const b = el('button', 'btn sm ghost', label);
      b.onclick = () => openApp(app);
      shortcuts.append(b);
    }
    welcome.append(grid, el('h3', '', 'One integrated workspace'), shortcuts, el('small', '', 'Research can be broad; actions with cost or external side effects still require your approval.'));
    log.append(welcome);
  }
  if (chatHistory.length) { for (const m of chatHistory) addMsg(m.role === 'user' ? 'user' : 'agent', m.content); }
  else greeting();

  function addMsg(role, text) {
    const textEl = el('div', 'text');
    textEl.innerHTML = md(text);
    const m = el(
      'div',
      'msg ' + role,
      el('div', 'avatar', role === 'user' ? '›' : '◈'),
      el('div', 'body', el('div', 'who', role === 'user' ? 'you' : 'Nexus'), textEl),
    );
    log.append(m);
    scrollDown();
    return m;
  }

  async function submit() {
    if (ta.value.trim().startsWith('/')) {
      const [head, ...rest] = ta.value.trim().split(' ');
      const key = head.slice(1).toLowerCase();
      if (SLASH[key]) {
        ta.value = SLASH[key] + rest.join(' ');
      } else {
        toast('unknown command — try ' + Object.keys(SLASH).map((k) => '/' + k).join(' '), 'warn');
        return;
      }
    }
    const text = ta.value.trim();
    if (!text || send.disabled) return;
    ++sessionRevision;
    ta.value = '';
    ta.style.height = 'auto';
    log.querySelector('.workspace-welcome')?.remove();
    addMsg('user', text);
    chatHistory.push({ role: 'user', content: text });

    const bubble = el('div', 'msg agent');
    const bodyEl = el('div', 'body');
    const who = el('div', 'who', roleSel.options[roleSel.selectedIndex]?.text || 'Nexus');
    const tools = el('div', 'toolrow');
    const live = el('div', 'live');
    const textEl = el('div', 'text');
    // Batch streaming text into animation frames instead of writing to the DOM per token.
    let pend = '';
    let raf = 0;
    bodyEl.append(who, tools, live, textEl);
    bubble.append(el('div', 'avatar', '◈'), bodyEl);
    log.append(bubble);
    scrollDown();

    send.disabled = true;
    win.busy = true;
    let answer = '';
    let chip = null;
    // A slow free-tier agent run used to lock the compose box for minutes with no way out.
    const ac = new AbortController();
    stop.style.display = '';
    stop.onclick = () => ac.abort();

    // The finally below guarantees the compose box unlocks even if the stream dies mid-response.
    try {
      await ssePost(
      '/api/chat',
      { input: text, messages: chatHistory, mode: chatMode, role: roleSel.value, attachments },
      (type, d) => {
        if (type === 'delta') {
          live.hidden = false;
          pend += d.text;
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0;
              live.textContent += pend;
              pend = '';
              if (nearBottom()) log.scrollTop = log.scrollHeight;
            });
          }
        } else if (type === 'tool_start') {
          live.textContent = '';
          live.hidden = true;
          chip = el(
            'div',
            'toolchip',
            el('span', 'spin'),
            el('span', '', d.name),
            el('span', 'faint', JSON.stringify(d.args).slice(0, 90)),
          );
          const detail = el('div', 'detail');
          chip.append(detail);
          chip.onclick = () => chip.classList.toggle('open');
          tools.append(chip);
          scrollDown();
        } else if (type === 'tool_end') {
          if (chip) {
            const sp = chip.querySelector('.spin');
            if (sp) sp.replaceWith(el('span', d.ok ? 'ok' : 'bad', d.ok ? '✓' : '✕'));
            chip.append(el('span', 'faint small', `${d.ms}ms`));
            const detail = chip.querySelector('.detail');
            if (detail) detail.textContent = d.preview || '';
          }
          chip = null;
        } else if (type === 'approval') {
          live.textContent = '';
          live.hidden = true;
          const card = el('div', 'approval');
          card.append(
            el('div', 'row', el('span', 'tag warn', d.risk), el('b', '', d.tool), el('span', 'grow'), el('span', 'faint small', 'needs approval')),
            el('div', 'small muted', d.reason),
            el('div', 'pre tight', String(d.summary || '').slice(0, 400)),
            d.file ? el('div', 'small faint mono', String(d.file).slice(-80)) : '',
            d.commandPreview
              ? el('div', '', el('div', 'small faint', 'command preview'), el('pre', 'pre tight diff-cmd', d.commandPreview))
              : '',
            d.diff && d.diff.deleted
              ? el('div', '', el('div', 'small faint', `delete · ${d.diff.lines || '?'} lines`), el('pre', 'pre tight diff-box', d.diff.preview || '(empty)'))
              : d.diff && d.diff.text
                ? el('div', '', el('div', 'small faint', `diff · +${d.diff.added || 0} −${d.diff.removed || 0}`), el('pre', 'pre tight diff-box', d.diff.text))
                : d.diff && d.diff.created
                  ? el('div', 'small faint', `new file · ${d.diff.lines} lines`)
                  : '',
          );
          const btns = el('div', 'row wrap');
          const decide = async (decision, scope, btn) => {
            card.querySelectorAll('button').forEach((b) => (b.disabled = true));
            btn.textContent = decision === 'allow' ? 'allowed' : 'denied';
            const r = await api('/api/approvals', { id: d.id, decision, scope });
            if (!r.ok) toast(r.error || 'approval expired', 'err');
            setTimeout(() => {
              card.style.opacity = '0.5';
              card.querySelectorAll('button').forEach((b) => b.remove());
              card.append(el('div', 'small faint', decision === 'allow' ? '✓ allowed' : '✕ denied'));
            }, 400);
          };
          const bOnce = el('button', 'btn sm primary', 'Allow once');
          const bSession = el('button', 'btn sm', 'Allow this session');
          const bAlways = el('button', 'btn sm', 'Always allow');
          const bDeny = el('button', 'btn sm danger', 'Deny');
          bOnce.onclick = () => decide('allow', 'once', bOnce);
          bSession.onclick = () => decide('allow', 'session', bSession);
          bAlways.onclick = () => decide('allow', 'always', bAlways);
          bDeny.onclick = () => decide('deny', 'once', bDeny);
          btns.append(bOnce, bSession, bAlways, bDeny);
          card.append(btns);
          tools.append(card);
          scrollDown();
        } else if (type === 'approval_resolved') {
          if (d.decision === 'deny') textEl.innerHTML = '';
        } else if (type === 'budget') {
          toast('Stopped: ' + d.reason, 'warn');
        } else if (type === 'checkpoint') {
          toast('Checkpoint saved · ' + String(d.file).split(/[\\/]/).pop());
        } else if (type === 'artifacts') {
          if (d.missing?.length) toast(`⚠ ${d.missing.length} claimed file(s) do not exist`, 'err');
          if (d.produced?.length) {
            const row = el('div', 'toolrow');
            for (const f of d.produced.slice(0, 6)) {
              const chip = el('div', 'toolchip', el('span', 'ok', '✓'), el('span', '', f.name), el('span', 'faint small', `${(f.bytes / 1024).toFixed(0)} KB`));
              chip.title = f.path;
              chip.onclick = () => openPreview(f.path);
              row.append(chip);
            }
            tools.append(row);
            scrollDown();
          }
        } else if (type === 'usage') {
          const t = d.totalTokens >= 1000 ? (d.totalTokens / 1000).toFixed(1) + 'k' : String(d.totalTokens);
          const c = d.costUsd > 0 ? '$' + d.costUsd.toFixed(4) : 'free';
          bodyEl.append(el('div', 'small faint', `≈${t} tokens · ${c} · ${d.priceLabel} · ${d.inputTokens} in / ${d.outputTokens} out`));
        } else if (type === 'narrative') {
          live.textContent = d.text;
        } else if (type === 'answer') {
          if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
          answer = d.text || '';
          live.remove();
          textEl.innerHTML = md(answer);
          scrollDown();
        } else if (type === 'provider') {
          const badge = el('div', 'small faint provider-used', 'Responding with ' + d.label);
          bodyEl.querySelector('.provider-used')?.remove();
          bodyEl.prepend(badge);
        } else if (type === 'error') {
          live.remove();
          textEl.innerHTML = `<p style="color:var(--rose)">${esc(d.message)}</p>`;
          toast(d.message.slice(0, 160), 'err');
        }
      },
        ac.signal,
      );
    } catch (e) {
      textEl.innerHTML = `<p style="color:var(--rose)">Unexpected error: ${esc(String(e.message || e))}</p>`;
    } finally {
      send.disabled = false;
      win.busy = false;
      stop.style.display = 'none';
    }
    attachments = [];
    renderChips();
    if (answer) chatHistory.push({ role: 'assistant', content: answer });
    persist();
    if (chatHistory.length > 24) chatHistory = chatHistory.slice(-24);
    ta.focus();
  }

  ta.setAttribute('aria-label', 'Message Nexus');
  send.setAttribute('aria-label', 'Send message');
  stop.setAttribute('aria-label', 'Stop task');
  send.onclick = submit;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && stop.style.display !== 'none') {
      stop.click();
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });
  setTimeout(() => ta.focus(), 60);

  win.sendToChat = (text) => {
    ta.value = text;
    submit();
  };

  // Resume the most recent session on open, so a reload or a restart does not lose the thread.
  (async () => {
    try {
      if (hadSavedContext || chatHistory.length) return;
      const list = await api('/api/sessions?workspaceId=' + encodeURIComponent(workspaceId));
      const last = (list.items || [])[0];
      if (!last) return;
      const full = await api('/api/sessions/' + last.id);
      if (win.chatRenderRevision !== renderRevision || sessionRevision || chatHistory.length || !body.isConnected || !full.ok || !(full.session.messages || []).length) return;
      if ((full.session.workspaceId || 'default') !== workspaceId) return;
      sessionId = full.session.id;
      chatHistory = full.session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      roleSel.value = roles.some((r) => r.id === full.session.role) ? full.session.role : 'core';
      chatContexts.set(workspaceId, { sessionId, messages: chatHistory, role: roleSel.value });
      clear(log);
      for (const m of chatHistory) addMsg(m.role === 'user' ? 'user' : 'agent', m.content);
      log.append(el('div', 'small faint', `resumed “${full.session.title}” · ${chatHistory.length} messages`));
      scrollDown();
    } catch {}
  })();
}

/* ------------------------------ search app ------------------------------- */
function renderSearch(body) {
  clear(body);
  const q = el('input');
  q.placeholder = 'Search the live web…';
  const go = el('button', 'btn primary', 'Search');
  const row = el('div', 'row', q, go);
  const out = el('div');
  out.style.marginTop = '12px';
  body.append(row, out);

  async function run() {
    const query = q.value.trim();
    if (!query) return;
    clear(out).append(el('div', 'empty', 'searching…'));
    const r = await api('/api/search', { q: query, max: 8 });
    clear(out);
    if (!r.results?.length) {
      out.append(el('div', 'empty', r.errors?.join(' · ') || 'no results'));
      return;
    }
    for (const item of r.results) {
      const card = el('div', 'card');
      const a = el('a', '', item.title || item.url);
      a.href = item.url;
      a.target = '_blank';
      card.append(a, el('div', 'small muted', item.snippet || ''), el('div', 'faint small mono', item.url));
      const actions = el('div', 'row', el('span', 'grow'));
      const bRead = el('button', 'btn sm', 'read here');
      bRead.onclick = async () => {
        const t = await api('/api/page', { url: item.url });
        const pre = el('div', 'pre', t.text || t.error || '');
        card.append(pre);
        bRead.remove();
      };
      const bBrowser = el('button', 'btn sm', 'open in chrome');
      bBrowser.onclick = () => api('/api/browser', { action: 'open', url: item.url }).then(() => toast('opened in Chrome'));
      actions.append(bRead, bBrowser);
      card.append(actions);
      out.append(card);
    }
  }
  go.onclick = run;
  q.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  setTimeout(() => q.focus(), 50);
}

/* ------------------------------ browser app ------------------------------ */
function renderBrowserClassic(body) {
  clear(body);
  const status = el('div', 'row wrap');
  const shotBox = el('div');
  const addr = el('input');
  addr.placeholder = 'https://…';
  const bGo = el('button', 'btn sm', 'open');
  const bShots = el('button', 'btn sm', 'snapshot');
  const bLaunch = el('button', 'btn sm primary', 'launch chrome');
  const bClose = el('button', 'btn sm ghost', 'quit');
  const tabsBox = el('div', 'small muted mono');
  tabsBox.style.marginTop = '6px';

  const ctrl = el('div', 'row wrap');
  const idx = el('input');
  idx.placeholder = 'element #';
  idx.style.width = '90px';
  const txt = el('input');
  txt.placeholder = 'text to type';
  const bClick = el('button', 'btn sm', 'click');
  const bType = el('button', 'btn sm', 'type');
  const bEnter = el('button', 'btn sm', '⏎');
  ctrl.append(idx, txt, bClick, bType, bEnter);

  const els = el('div', 'el-list');
  const out = el('div', 'pre');
  out.style.display = 'none';

  body.append(
    el('div', 'row wrap', bLaunch, bShots, el('span', 'grow'), bClose),
    el('div', 'row', addr, bGo),
    tabsBox,
    status,
    shotBox,
    el('div', 'small faint', 'Page elements'),
    ctrl,
    els,
    out,
  );

  async function refresh() {
    const r = await api('/api/browser', { action: 'status' });
    clear(status);
    status.append(
      el('span', 'tag ' + (r.result?.running ? 'ok' : 'err'), r.result?.running ? 'connected' : 'not running'),
      el('span', 'faint small mono', ` :${r.result?.port || 9222}`),
    );
    tabsBox.textContent = (r.result?.tabs || []).map((t) => `· ${t.title || t.url}`).join('\n') || 'no tabs';
  }

  async function snap() {
    clear(els).append(el('div', 'empty', 'reading page…'));
    const r = await api('/api/browser', { action: 'snapshot' });
    if (!r.ok) {
      clear(els).append(el('div', 'empty', r.error || 'no page'));
      return;
    }
    const s = r.result;
    addr.value = s.url || '';
    clear(els);
    els.append(el('div', 'small faint', `${s.title || ''} — ${s.elements.length} interactive elements`));
    for (const e of s.elements.slice(0, 150)) {
      const row = el('div', 'el', el('span', 'i', String(e.i)), el('span', 't', `${e.tag}${e.type ? '·' + e.type : ''} — ${e.label || e.placeholder || e.href}`));
      row.onclick = () => {
        idx.value = e.i;
        if (e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select') txt.focus();
      };
      els.append(row);
    }
  }

  bLaunch.onclick = async () => {
    toast('launching Chrome with the Nexus profile…');
    const r = await api('/api/browser', { action: 'launch', url: addr.value || undefined });
    if (!r.ok) toast(r.error || 'failed', 'err');
    await refresh();
  };
  bShots.onclick = async () => {
    const r = await api('/api/browser', { action: 'screenshot' });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    const img = el('img', 'shot');
    img.src = '/shots/' + r.result.file;
    clear(shotBox).append(img);
    await snap();
  };
  bGo.onclick = async () => {
    const r = await api('/api/browser', { action: 'open', url: addr.value });
    if (!r.ok) toast(r.error || 'failed', 'err');
    setTimeout(snap, 900);
  };
  bClose.onclick = async () => {
    await api('/api/browser', { action: 'close' });
    refresh();
  };
  bClick.onclick = async () => {
    const r = await api('/api/browser', { action: 'click', index: Number(idx.value) });
    out.style.display = 'block';
    out.textContent = JSON.stringify(r.result, null, 2).slice(0, 3000);
  };
  bType.onclick = async () => {
    const r = await api('/api/browser', { action: 'type', index: Number(idx.value), text: txt.value });
    if (!r.ok) toast(r.error || 'failed', 'err');
  };
  bEnter.onclick = async () => {
    const r = await api('/api/browser', { action: 'press', key: 'Enter' });
    setTimeout(snap, 900);
  };
  refresh();
}

/* ------------------------------- agents app ------------------------------ */
function renderAgents(body, win) {
  clear(body);
  const brief = el('textarea');
  brief.placeholder = 'What should the cluster work on? e.g. "Find three open Kaggle competitions worth entering, size the effort, and propose the fastest baseline."';
  const chips = el('div', 'row wrap');
  const chosen = new Set(['researcher', 'analyst', 'critic']);
  const selected = state.roles.filter((r) => r.id !== 'core');
  for (const r of selected) {
    const c = el('div', 'chip' + (chosen.has(r.id) ? ' on' : ''), `${r.emoji || '◇'} ${r.name}`);
    c.onclick = () => {
      chosen.has(r.id) ? chosen.delete(r.id) : chosen.add(r.id);
      c.classList.toggle('on');
    };
    chips.append(c);
  }
  const go = el('button', 'btn primary', 'Run cluster');
  const out = el('div');
  out.style.marginTop = '12px';
  body.append(el('div', 'small faint', 'Sub-agents run in parallel, then a core agent synthesises one answer.'), brief, el('div', 'row', el('span', 'grow'), go), chips, out);

  go.onclick = async () => {
    const text = brief.value.trim();
    if (!text) return;
    clear(out);
    const grid = el('div', 'agent-grid');
    out.append(grid);
    const cards = new Map();
    const finalBox = el('div', 'card');
    finalBox.style.marginTop = '10px';
    out.append(finalBox);

    const card = (role, label) => {
      let c = cards.get(role);
      if (!c) {
        c = el('div', 'agent-card', el('div', 'head', label), el('div', 'out', '…'));
        cards.set(role, c);
        grid.append(c);
      }
      return c;
    };

    go.disabled = true;
    await ssePost('/api/cluster', { brief: text, roles: [...chosen] }, (type, d) => {
      if (type === 'cluster_start') {
        for (const r of d.roles) {
          const meta = state.roles.find((x) => x.id === r);
          card(r, `${meta?.emoji || '◇'} ${meta?.name || r}`);
        }
      } else if (type === 'cluster_child') {
        const c = card(d.role, d.role);
        const o = c.querySelector('.out');
        if (d.type === 'delta') o.textContent += d.text;
        if (d.type === 'tool_start') o.textContent += `\n→ ${d.name}`;
      } else if (type === 'cluster_done') {
        const c = cards.get(d.role);
        if (c) {
          c.querySelector('.out').textContent = d.answer || '(no output)';
          c.querySelector('.head').append(el('span', 'tag ok', 'done'));
        }
      } else if (type === 'delta') {
        finalBox.innerHTML = '';
        finalBox.append(el('div', 'small faint', 'synthesis'));
        const t = el('div', 'text');
        t.innerHTML = md(d.text);
        finalBox.append(t);
      } else if (type === 'answer') {
        finalBox.innerHTML = '';
        finalBox.append(el('div', 'small faint', 'final answer'), Object.assign(el('div', 'text'), { innerHTML: md(d.text) }));
      } else if (type === 'error') {
        toast(d.message, 'err');
      }
    });
    go.disabled = false;
  };

  if (win.argBrief) {
    brief.value = win.argBrief;
    win.argBrief = '';
  }
}

/* -------------------------------- tasks app ------------------------------ */
function renderTasks(body) {
  clear(body);
  const when = el('input');
  when.placeholder = 'every 30m · daily 09:00 · */15 * * * *';
  const label = el('input');
  label.placeholder = 'label (optional)';
  const prompt = el('textarea');
  prompt.placeholder = 'What should Nexus do each time? e.g. "Check today’s calendar, list conflicts, and email me a plan for the day."';
  const add = el('button', 'btn primary', 'Schedule it');
  const listBox = el('div');
  body.append(
    el('h3', '', 'New automation'),
    el('div', 'row', when, label),
    el('div', '', prompt),
    el('div', 'row', el('span', 'grow'), add),
    el('h3', '', 'Scheduled'),
    listBox,
  );

  async function refresh() {
    const r = await api('/api/tasks');
    state.tasks = r.tasks || [];
    clear(listBox);
    if (!state.tasks.length) listBox.append(el('div', 'empty', 'nothing scheduled yet'));
    for (const t of state.tasks) {
      const next = t.nextRun ? new Date(t.nextRun).toLocaleString() : '—';
      const card = el('div', 'card');
      const head = el('div', 'row', el('b', '', t.label), el('span', 'grow'), el('span', 'tag ' + (t.enabled ? 'ok' : ''), t.enabled ? 'on' : 'paused'));
      const meta = el('div', 'small faint mono', `${t.schedule.label} · next ${next} · runs ${t.runs || 0}`);
      const actions = el('div', 'row', el('span', 'grow'));
      const bRun = el('button', 'btn sm', 'run now');
      bRun.onclick = async () => {
        bRun.disabled = true;
        bRun.textContent = 'running…';
        const rr = await api('/api/tasks', { action: 'run', id: t.id });
        bRun.disabled = false;
        bRun.textContent = 'run now';
        if (rr.ok) toast('task finished');
        else toast(rr.error || 'failed', 'err');
        refresh();
      };
      const bToggle = el('button', 'btn sm ghost', t.enabled ? 'pause' : 'resume');
      bToggle.onclick = async () => {
        await api('/api/tasks', { action: 'toggle', id: t.id, enabled: !t.enabled });
        refresh();
      };
      const bDel = el('button', 'btn sm danger', 'delete');
      bDel.onclick = async () => {
        await api('/api/tasks', { action: 'delete', id: t.id });
        refresh();
      };
      actions.append(bRun, bToggle, bDel);
      card.append(head, meta, el('div', 'small muted', t.prompt.slice(0, 160)), actions);
      if (t.lastResult) {
        const d = el('details');
        d.append(el('summary', 'small faint', 'last result'), el('div', 'pre', t.lastResult));
        card.append(d);
      }
      if (t.lastError) card.append(el('div', 'small', el('span', 'tag err', 'error'), ' ' + t.lastError.slice(0, 200)));
      listBox.append(card);
    }
  }

  add.onclick = async () => {
    const r = await api('/api/tasks', { when: when.value, label: label.value, prompt: prompt.value });
    if (r.ok) {
      toast('scheduled');
      prompt.value = '';
      label.value = '';
      refresh();
    } else toast(r.error, 'err');
  };
  refresh();
  panelPoll(body, refresh, 20000);
}

/* -------------------------------- skills app ----------------------------- */
function renderSkillsClassic(body) {
  clear(body);
  const listBox = el('div');
  const reader = el('div');
  body.append(el('div', 'small faint', 'Skills are markdown instructions injected into every agent run. Drop a folder in nexus/skills/<name>/SKILL.md to add one.'), listBox, el('h3', '', 'Reader'), reader);

  async function refresh() {
    const r = await api('/api/skills');
    state.skills = r.skills || [];
    clear(listBox);
    for (const s of state.skills) {
      const card = el('div', 'card tight');
      const sw = el('div', 'switch' + (s.enabled ? ' on' : ''));
      sw.onclick = async () => {
        sw.classList.toggle('on');
        await api('/api/skills', { action: 'toggle', id: s.id, on: sw.classList.contains('on') });
        refresh();
      };
      const title = el('div', 'row', el('b', '', s.name), el('span', 'grow'), el('span', 'badge', `${s.chars} chars`), sw);
      const desc = el('div', 'small muted', s.description || '');
      const bRead = el('button', 'btn sm ghost', 'read');
      bRead.onclick = async () => {
        const rr = await api('/api/skills', { action: 'read', id: s.id });
        clear(reader).append(el('div', 'pre', rr.skill?.body || ''));
      };
      card.append(title, desc, el('div', 'row', bRead));
      listBox.append(card);
    }
    if (!state.skills.length) listBox.append(el('div', 'empty', 'no skills installed'));
  }
  refresh();
}

/* --------------------------------- mail app ------------------------------ */
function renderMail(body) {
  clear(body);
  const status = el('div', 'row');
  const q = el('input');
  q.placeholder = 'Gmail search · e.g. newer_than:2d is:unread';
  q.value = 'newer_than:3d';
  const go = el('button', 'btn sm', 'search');
  const out = el('div');
  const compose = el('div');
  body.append(status, el('div', 'row', q, go), out, el('h3', '', 'Compose'), compose);

  clear(status).append(
    el('span', 'tag ' + (state.googleConnected ? 'ok' : 'err'), state.googleConnected ? `connected ${state.settings?.google?.email || ''}` : 'not connected'),
  );
  if (!state.googleConnected) {
    const b = el('button', 'btn sm primary', 'connect google');
    b.onclick = () => connectGoogle(body);
    status.append(b);
  }

  async function run() {
    clear(out).append(el('div', 'empty', 'reading inbox…'));
    const rr = await api('/api/mail/search', { q: q.value }).catch(() => ({ ok: false }));
    clear(out);
    if (!rr || rr.ok === false) {
      out.append(el('div', 'empty', rr?.error || 'Mail search needs the Google connection.'));
      return;
    }
    for (const m of rr.messages || []) {
      const card = el('div', 'card tight');
      card.append(
        el('div', 'row', el('b', '', m.subject || '(no subject)'), el('span', 'grow'), m.unread ? el('span', 'tag warn', 'unread') : ''),
        el('div', 'small faint', `${m.from} · ${m.date}`),
        el('div', 'small muted', m.snippet || ''),
      );
      const bOpen = el('button', 'btn sm ghost', 'read');
      bOpen.onclick = async () => {
        const r2 = await api('/api/mail/read', { id: m.id });
        card.append(el('div', 'pre', r2.message?.body || r2.error || ''));
      };
      card.append(el('div', 'row', bOpen));
      out.append(card);
    }
    if (!(rr.messages || []).length) out.append(el('div', 'empty', 'no messages'));
  }
  go.onclick = run;

  const to = el('input');
  to.placeholder = 'to@example.com';
  const subj = el('input');
  subj.placeholder = 'subject';
  const text = el('textarea');
  text.placeholder = 'message';
  const send = el('button', 'btn primary', 'send');
  send.onclick = async () => {
    const r = await api('/api/mail/send', { to: to.value, subject: subj.value, body: text.value });
    r.ok ? toast('sent') : toast(r.error || 'failed', 'err');
  };
  compose.append(to, el('div', '', subj), text, el('div', 'row', el('span', 'grow'), send));
  setTimeout(run, 250);
}

async function connectGoogle(hostBody = document.body) {
  const r = await api('/api/google/auth', {});
  if (!r.ok) return toast(r.error, 'err');
  window.open(r.url, '_blank', 'width=520,height=680');
  const iv = panelPoll(hostBody, async () => {
    const st = await api('/api/state');
    if (st.googleConnected) {
      state.googleConnected = true;
      state.settings = st.settings;
      clearInterval(iv);
      toast('Google connected');
      refreshHeader();
      hostBody.dispatchEvent(new Event('nexus-google-connected'));
    }
  }, 2500);
  hostBody.addEventListener('nexus-dispose', () => clearInterval(iv), { once: true });
  setTimeout(() => clearInterval(iv), 300000);
}

function renderDrive(body) {
  clear(body);
  const status = el('div', 'row wrap');
  const query = el('input');
  query.placeholder = 'Search Drive filenames';
  query.style.flex = '1';
  const search = el('button', 'btn sm primary', 'search Drive');
  const connect = el('button', 'btn sm', 'connect Google');
  const out = el('div');
  const openGmail = el('button', 'btn sm ghost', 'open Gmail');
  openGmail.onclick = () => openApp('mail');
  connect.onclick = () => connectGoogle(body);
  search.onclick = runSearch;
  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') search.click(); });
  body.append(
    el('div', 'card', el('b', '', 'Google Drive'), el('div', 'small muted', 'Connect Google once to search and read your Drive files. Nexus only reads files you request here or through the agent.')),
    status,
    el('div', 'row', query, search, connect, openGmail),
    out,
  );
  refreshStatus();
  const onGoogleConnected = () => refreshStatus();
  body.addEventListener('nexus-google-connected', onGoogleConnected);
  body.addEventListener('nexus-dispose', () => {
    body.removeEventListener('nexus-google-connected', onGoogleConnected);
  }, { once: true });

  async function refreshStatus() {
    const r = await api('/api/state').catch(() => ({}));
    state.googleConnected = Boolean(r.googleConnected);
    state.settings = r.settings || state.settings;
    clear(status).append(
      el('span', 'tag ' + (state.googleConnected ? 'ok' : 'warn'), state.googleConnected ? `Google connected · ${state.settings?.google?.email || ''}` : 'Google not connected'),
      el('span', 'grow'),
      (() => {
        const b = el('button', 'btn sm ghost', 'refresh status');
        b.onclick = refreshStatus;
        return b;
      })(),
    );
    connect.hidden = state.googleConnected;
  }

  async function runSearch() {
    clear(out).append(el('div', 'empty', 'Searching Google Drive…'));
    const r = await api('/api/drive/search', { q: query.value.trim(), limit: 30 }).catch((e) => ({ ok: false, error: e.message }));
    clear(out);
    if (!r.ok) return out.append(el('div', 'empty', r.error || 'Drive search failed'));
    if (!(r.files || []).length) return out.append(el('div', 'empty', 'No Drive files found'));
    for (const file of r.files) {
      const card = el('div', 'card tight');
      const read = el('button', 'btn sm', 'read');
      read.onclick = async () => {
        read.disabled = true;
        const result = await api('/api/drive/read', { id: file.id, maxChars: 12000 }).catch((e) => ({ ok: false, error: e.message }));
        read.disabled = false;
        if (!result.ok) return toast(result.error || 'could not read file', 'err');
        const pre = el('div', 'pre', result.file?.text || 'This file has no readable text content.');
        card.append(pre);
      };
      const open = el('button', 'btn sm ghost', 'open in Google');
      open.onclick = () => file.webViewLink && window.open(file.webViewLink, '_blank');
      card.append(
        el('div', 'row', el('b', 'ellipsis', file.name || '(unnamed)'), el('span', 'grow'), read, open),
        el('div', 'small faint', `${file.mimeType || 'file'} · ${file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : 'date unknown'}${file.size ? ` · ${file.size} bytes` : ''}`),
      );
      out.append(card);
    }
  }
}

/* -------------------------------- kaggle app ----------------------------- */
function renderKaggle(body) {
  clear(body);
  const status = el('div', 'row wrap');
  const q = el('input');
  q.placeholder = 'search competitions / datasets / kernels';
  const tabs = el('div', 'row wrap');
  const out = el('div');
  let mode = 'competitions';

  const mk = (m, label) => {
    const b = el('button', 'btn sm' + (mode === m ? ' primary' : ''), label);
    b.onclick = () => {
      mode = m;
      $$('.btn', tabs).forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      load();
    };
    return b;
  };
  tabs.append(mk('competitions', 'competitions'), mk('datasets', 'datasets'), mk('kernels', 'my kernels'));

  clear(status).append(
    el('span', 'tag ' + (state.kaggleConfigured ? 'ok' : 'err'), state.kaggleConfigured ? `api · ${state.settings?.kaggle?.username}` : 'no credentials'),
  );
  const bTest = el('button', 'btn sm', 'test + install kaggle.json');
  bTest.onclick = async () => {
    const r = await api('/api/kaggle/test', {});
    r.ok ? toast(`Kaggle OK · ${r.username}`) : toast(r.error || 'failed', 'err');
  };
  status.append(bTest);

  async function load() {
    clear(out).append(el('div', 'empty', 'loading…'));
    const r = await api('/api/kaggle/list', { action: mode, search: q.value });
    clear(out);
    if (!r.ok) return out.append(el('div', 'empty', r.error || 'failed'));
    for (const item of r.items || []) {
      const card = el('div', 'card tight');
      const a = el('a', '', item.title || item.ref);
      a.href = item.url;
      a.target = '_blank';
      const bits = [item.deadline && `deadline ${String(item.deadline).slice(0, 10)}`, item.size && `${Math.round(item.size / 1e6)} MB`, item.status && `status ${item.status}`, item.category];
      card.append(a, el('div', 'small faint mono', item.ref), el('div', 'small muted', bits.filter(Boolean).join(' · ')));
      if (item.ref && item.url?.includes('/code/')) {
        const b = el('button', 'btn sm ghost', 'status');
        b.onclick = async () => {
          const rr = await api('/api/kaggle/list', { action: 'status', ref: item.ref });
          card.append(el('div', 'pre', JSON.stringify(rr.items ?? rr, null, 2)));
        };
        card.append(b);
      }
      out.append(card);
    }
    if (!(r.items || []).length) out.append(el('div', 'empty', 'nothing found'));
  }
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  body.append(status, el('div', 'row', q), tabs, out);
  load();
}

/* ------------------------------- terminal app ---------------------------- */
function renderTerminal(body) {
  clear(body);
  const log = el('div', 'pre');
  log.style.height = 'calc(100% - 44px)';
  log.style.maxHeight = 'none';
  const line = el('div', 'term-line');
  const ps = el('span', 'ps', 'PS>');
  const cmd = el('input');
  cmd.style.border = '0';
  cmd.style.background = 'transparent';
  cmd.placeholder = 'python --version · dir · git status';
  cmd.spellcheck = false;
  line.append(ps, cmd);
  body.append(log, line);
  const history = [];
  let hIdx = -1;

  async function run(text) {
    if (!text.trim()) return;
    history.push(text);
    hIdx = history.length;
    log.append(el('div', 'mono small', `PS> ${text}`));
    const r = await api('/api/shell', { command: text });
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    log.append(el('div', 'mono small', out || `(exit ${r.code}${r.timedOut ? ', timed out' : ''})`));
    log.scrollTop = log.scrollHeight;
    cmd.value = '';
  }
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run(cmd.value);
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hIdx > 0) cmd.value = history[--hIdx] || '';
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hIdx < history.length - 1) cmd.value = history[++hIdx] || '';
      else {
        hIdx = history.length;
        cmd.value = '';
      }
    }
  });
  setTimeout(() => cmd.focus(), 60);
}

/* -------------------------------- memory app ----------------------------- */
function renderMemory(body) {
  clear(body);
  const inp = el('textarea');
  inp.placeholder = 'Something Nexus should remember about you…';
  const add = el('button', 'btn primary', 'remember');
  const listBox = el('div');
  body.append(el('div', 'small faint', 'Memory is injected into the agent prompt on every run.'), inp, el('div', 'row', el('span', 'grow'), add), el('h3', '', 'Stored'), listBox);

  async function refresh() {
    const r = await api('/api/memory');
    clear(listBox);
    for (const m of r.items || []) {
      const card = el('div', 'card tight');
      const del = el('button', 'btn sm ghost', '✕');
      del.onclick = async () => {
        await api('/api/memory', { action: 'delete', id: m.id });
        refresh();
      };
      card.append(el('div', 'row', el('span', 'faint small mono', m.createdAt?.slice(0, 16) || ''), el('span', 'grow'), del), el('div', 'small', m.text));
      listBox.append(card);
    }
    if (!(r.items || []).length) listBox.append(el('div', 'empty', 'empty'));
  }
  add.onclick = async () => {
    if (!inp.value.trim()) return;
    await api('/api/memory', { text: inp.value });
    inp.value = '';
    refresh();
  };
  refresh();
}

/* --------------------------------- files app ----------------------------- */
function renderFilesClassic(body) {
  clear(body);
  const dir = el('input');
  dir.value = '.';
  const go = el('button', 'btn sm', 'list');
  const listBox = el('div');
  const viewer = el('div', 'pre');
  viewer.style.display = 'none';
  body.append(el('div', 'row', dir, go), listBox, viewer);

  async function load() {
    clear(listBox).append(el('div', 'empty', 'reading…'));
    const rr = await api('/api/fs/list', { dir: dir.value }).catch(() => null);
    clear(listBox);
    if (!rr || !rr.ok) {
      listBox.append(el('div', 'empty', rr?.error || 'file API unavailable'));
      return;
    }
    for (const it of rr.items || []) {
      const row = el('div', 'el', el('span', 'i', it.dir ? '▸' : '·'), el('span', 't', it.name), el('span', 'faint small', it.dir ? '' : `${it.size}b`));
      row.onclick = async () => {
        if (it.dir) {
          dir.value = rr.path + '\\' + it.name;
          load();
        } else {
          const f = await api('/api/fs/read', { path: rr.path + '\\' + it.name });
          viewer.style.display = 'block';
          viewer.textContent = f.text || f.error;
        }
      };
      listBox.append(row);
    }
  }
  go.onclick = load;
  dir.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  load();
}

/* ------------------------------- settings app ---------------------------- */
function renderSettings(body) {
  clear(body);
  const s = state.settings;
  const save = async (patch) => {
    const r = await api('/api/settings', patch);
    if (r.ok) {
      state.settings = r.settings;
      toast('saved');
      refreshHeader();
    } else toast(r.error || 'failed', 'err');
  };

  const field = (label, input, hint) => {
    const l = el('label', 'field', el('span', '', label), input);
    if (hint) l.append(el('div', 'small faint', hint));
    return l;
  };

  const openConnections = el('button', 'btn sm primary', 'Open Connections');
  openConnections.onclick = () => openApp('connect');
  const openMcpSettings = el('button', 'btn sm', 'Manage MCP servers');
  openMcpSettings.onclick = () => openApp('mcp');
  const openExtensions = el('button', 'btn sm', 'Extensions');
  openExtensions.onclick = () => openApp('plugins');
  const openBrowserSettings = el('button', 'btn sm', 'Persistent browser');
  openBrowserSettings.onclick = () => openApp('browser');
  const mcpCard = el(
    'div',
    'card',
    el('div', 'row', el('b', '', 'Agent tools'), el('span', 'grow'), openMcpSettings),
    el('div', 'small muted', 'Connect trusted MCP servers such as GitHub and Playwright. Server tools are executable capabilities and remain subject to Nexus approvals.'),
  );
  const setupGuides = el('details');
  const guideLink = (url, label) => {
    const b = el('button', 'btn sm ghost', label);
    b.onclick = () => window.open(url, '_blank', 'noopener,noreferrer');
    return b;
  };
  setupGuides.append(
    el('summary', '', 'Local setup guides and official downloads'),
    el('div', 'small muted', 'Set up local Ollama and cloud models in Connections. Never install an agent or browser extension from an unverified download.'),
    el('div', 'row wrap',
      guideLink('https://ollama.com/download', 'Ollama'),
      guideLink('https://www.google.com/chrome/', 'Chrome'),
      guideLink('https://www.microsoft.com/edge/download', 'Microsoft Edge'),
      guideLink('https://code.visualstudio.com/download', 'VS Code'),
      guideLink('https://nodejs.org/en/download', 'Node.js'),
    ),
    el('div', 'small faint mono', 'Install Ollama, then pull a model listed by ollama.com/library.'),
  );

  /* shell + browser */
  const shellOn = el('div', 'switch' + (s.shell.enabled ? ' on' : ''));
  shellOn.onclick = () => shellOn.classList.toggle('on');
  const port = el('input');
  port.type = 'number';
  port.value = s.browser.port;
  const persona = el('input');
  persona.value = s.agent.user || '';
  persona.placeholder = 'what should Nexus call you';

  const saveAll = el('button', 'btn primary', 'Save system settings');
  saveAll.onclick = () =>
    save({
      shell: { enabled: shellOn.classList.contains('on') },
      browser: { port: Number(port.value) },
      agent: { user: persona.value },
    });

  body.append(
    mcpCard,
    el('div', 'card', el('b', '', 'One Connections hub'), el('div', 'small muted', 'Model APIs, search, Google, Kaggle, GitHub, Discord, and Telegram are set up together in Connections. MCP servers, extensions, and browser controls stay in their dedicated tools.'), el('div', 'row wrap', openConnections, openMcpSettings, openExtensions, openBrowserSettings)),
    setupGuides,
    el('h3', '', 'System'),
    el('div', 'row', el('span', '', 'Shell access'), el('span', 'grow'), shellOn),
    el('div', 'split', field('Chrome debug port', port), field('What to call you', persona)),
    el('div', 'row', el('span', 'grow'), saveAll),
  );
}

/* -------------------------------- doctor app ----------------------------- */
function renderDoctor(body) {
  clear(body);
  const out = el('div');
  const b = el('button', 'btn sm', 'run diagnostics');
  body.append(el('div', 'small faint', 'Checks models, Chrome, Google, Kaggle, skills and disk access.'), el('div', 'row', b), out);

  async function run() {
    clear(out).append(el('div', 'empty', 'checking…'));
    const r = await api('/api/doctor');
    clear(out);
    for (const c of r.checks || []) {
      const card = el('div', 'card tight');
      card.append(
        el('div', 'row', el('span', 'tag ' + (c.ok ? 'ok' : 'err'), c.ok ? 'pass' : 'fail'), el('b', '', c.name), el('span', 'grow')),
        el('div', 'small muted', c.detail || ''),
      );
      if (!c.ok && c.fix) card.append(el('div', 'small faint', '→ ' + c.fix));
      out.append(card);
    }
    const m = r.models || {};
    if (m.models?.length) out.append(el('div', 'pre', 'models: ' + m.models.join('\n')));
    else if (m.error) out.append(el('div', 'pre', m.error + (m.hint ? '\n' + m.hint : '')));
  }
  b.onclick = run;
  run();
}

/* --------------------------------- safety app ---------------------------- */
function renderSafety(body) {
  clear(body);
  const p = state.policy || { modes: {}, rules: [] };
  let mode = p.mode || 'ask';

  const modeGrid = el('div', 'agent-grid');
  const auditBox = el('div');
  const rulesBox = el('div');
  const cpBox = el('div');

  const modeCards = {};
  Object.entries(p.modes || {}).forEach(([id, info]) => {
    const card = el('div', 'mode-card' + (id === mode ? ' on' : ''));
    card.append(el('div', 'mode-head', el('b', '', info.label), el('span', 'grow'), id === mode ? el('span', 'tag ok', 'active') : ''));
    card.append(el('div', 'small muted', info.desc));
    card.onclick = async () => {
      mode = id;
      Object.entries(modeCards).forEach(([k, c]) => {
        c.classList.toggle('on', k === id);
        const t = c.querySelector('.tag');
        if (t) t.remove();
        if (k === id) c.querySelector('.mode-head').append(el('span', 'tag ok', 'active'));
      });
      await api('/api/policy', { mode: id });
      state.policy.mode = id;
      toast('mode: ' + info.label);
    };
    modeCards[id] = card;
    modeGrid.append(card);
  });

  async function loadAudit() {
    const r = await api('/api/audit?limit=120');
    clear(auditBox);
    if (!r.entries?.length) return auditBox.append(el('div', 'empty', 'no tool calls logged yet'));
    for (const e of r.entries) {
      const row = el('div', 'audit-row');
      row.append(
        el('span', 'mono faint', e.ts.slice(11, 19)),
        el('span', 'tag ' + (e.decision === 'deny' ? 'err' : e.decision === 'executed' ? 'ok' : 'warn'), e.decision),
        el('span', 'mono small', e.tool),
        el('span', 'small muted grow ellipsis', e.summary || e.reason || ''),
        e.ms ? el('span', 'faint small mono', e.ms + 'ms') : '',
      );
      auditBox.append(row);
    }
  }

  async function loadRules() {
    const r = await api('/api/policy');
    state.policy = r;
    clear(rulesBox);
    if (!r.rules?.length) rulesBox.append(el('div', 'small faint', 'No rules. Everything follows the mode above.'));
    for (const rule of r.rules || []) {
      const row = el('div', 'row card tight', el('span', 'mono small', rule.match), el('span', 'grow'), el('span', 'tag ' + (rule.decision === 'deny' ? 'err' : 'ok'), rule.decision));
      const del = el('button', 'btn sm ghost', '✕');
      del.onclick = async () => {
        await api('/api/policy/rule', { action: 'remove', match: rule.match });
        loadRules();
      };
      row.append(del);
      rulesBox.append(row);
    }
  }

  async function loadCp() {
    const r = await api('/api/checkpoints');
    clear(cpBox);
    if (!r.items?.length) return cpBox.append(el('div', 'small faint', 'No checkpoints yet. Files are backed up before the agent edits them.'));
    for (const c of r.items.slice(0, 40)) {
      const row = el('div', 'row card tight', el('span', 'mono small ellipsis grow', c.file), el('span', 'faint small mono', c.ts.slice(5, 16)));
      const b = el('button', 'btn sm', 'restore');
      b.onclick = async () => {
        const rr = await api('/api/checkpoints/restore', { backup: c.backup });
        rr.ok ? toast('restored ' + String(rr.restored).split(/[\\/]/).pop()) : toast(rr.error || 'failed', 'err');
      };
      row.append(b);
      cpBox.append(row);
    }
  }

  const matchIn = el('input');
  matchIn.placeholder = 'shell:git *   ·   files:write *   ·   open_page:*';
  const decSel = el('select');
  decSel.style.width = 'auto';
  for (const d of ['allow', 'deny']) decSel.append(el('option', '', d));
  const addRule = el('button', 'btn sm', 'add rule');
  addRule.onclick = async () => {
    if (!matchIn.value.trim()) return;
    await api('/api/policy/rule', { match: matchIn.value.trim(), decision: decSel.value });
    matchIn.value = '';
    loadRules();
  };

  const bRefresh = el('button', 'btn sm', 'refresh');
  bRefresh.onclick = () => {
    loadAudit();
    loadRules();
    loadCp();
  };

  body.append(
    el('div', 'small faint', 'Every tool call passes through this gate. Denials are final for that call — the agent is told to find another route.'),
    h3('Permission mode'),
    modeGrid,
    h3('Rules (deny beats allow, rules beat mode)'),
    rulesBox,
    el('div', 'row', matchIn, decSel, addRule),
    h3('Checkpoints'),
    cpBox,
    el('div', 'row', h3('Audit log'), el('span', 'grow'), bRefresh),
    auditBox,
  );
  loadAudit();
  loadRules();
  loadCp();
}

function h3(text) {
  return el('h3', '', text);
}

/* --------------------------------- vault app ------------------------------ */
function renderVault(body) {
  clear(body);
  const box = el('div');
  body.append(box);

  async function refresh() {
    const st = await api('/api/vault');
    clear(box);

    if (!st.exists) {
      const p1 = el('input');
      p1.type = 'password';
      p1.placeholder = 'master passphrase (min 8 chars)';
      const p2 = el('input');
      p2.type = 'password';
      p2.placeholder = 'repeat it';
      const go = el('button', 'btn primary', 'Create encrypted vault');
      go.onclick = async () => {
        if (p1.value !== p2.value) return toast('passphrases do not match', 'err');
        const r = await api('/api/vault', { action: 'create', passphrase: p1.value });
        if (!r.ok) return toast(r.error, 'err');
        toast('vault created');
        refresh();
      };
      box.append(
        el('div', 'card', el('b', '', 'One passphrase, everything else encrypted.'), el('div', 'small muted', 'AES-256-GCM with a scrypt-derived key. The passphrase is never stored — if you lose it, the data is gone. That is the point.')),
        el('div', 'row', p1), el('div', 'row', p2), el('div', 'row', go),
        el('div', 'small faint', 'This vault stores the accounts you type in. It never reads Chrome’s saved passwords.'),
      );
      return;
    }

    if (!st.unlocked) {
      const p = el('input');
      p.type = 'password';
      p.placeholder = 'master passphrase';
      const go = el('button', 'btn primary', 'Unlock');
      go.onclick = async () => {
        const r = await api('/api/vault', { action: 'unlock', passphrase: p.value });
        if (!r.ok) return toast(r.error, 'err');
        refresh();
      };
      p.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
      box.append(
        el('div', 'row', el('span', 'tag warn', 'locked'), el('span', 'small muted', `${st.entries} entries on disk`), el('span', 'grow')),
        el('div', 'row', p, go),
        el('div', 'small faint', 'The key lives in memory only. Locking or restarting wipes it.'),
      );
      return;
    }

    // unlocked
    const search = el('input');
    search.placeholder = 'search service, username, note, tag…';
    const listBox = el('div');
    const bLock = el('button', 'btn sm ghost', 'lock');
    bLock.onclick = async () => { await api('/api/vault', { action: 'lock' }); refresh(); };
    const bAdd = el('button', 'btn sm primary', '+ new entry');

    const draw = (items) => {
      clear(listBox);
      if (!items.length) return listBox.append(el('div', 'empty', 'no entries yet'));
      for (const e of items) {
        const card = el('div', 'card tight');
        const head = el('div', 'row', el('b', '', e.service), el('span', 'small faint', e.username), el('span', 'grow'));
        const copyUser = el('button', 'btn sm ghost', 'copy user');
        copyUser.onclick = () => {
          navigator.clipboard.writeText(e.username || '');
          toast('username copied');
        };
        const bPass = el('button', 'btn sm', 'reveal');
        bPass.onclick = async () => {
          const r = await api('/api/vault', { action: 'reveal', id: e.id });
          if (!r.ok) return toast(r.error, 'err');
          const out = el('div', 'pre tight', r.entry.password || '(no password stored)');
          card.append(out);
          bPass.remove();
          const cp = el('button', 'btn sm', 'copy');
          cp.onclick = () => {
            navigator.clipboard.writeText(r.entry.password || '');
            toast('copied — clipboard clears in 30s');
            setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000);
          };
          head.append(cp);
        };
        const bDel = el('button', 'btn sm danger', '✕');
        bDel.onclick = async () => {
          await api('/api/vault', { action: 'delete', id: e.id });
          refresh();
        };
        head.append(bPass, copyUser, bDel);
        card.append(head);
        if (e.url) card.append(el('div', 'small faint mono', e.url));
        if (e.notes) card.append(el('div', 'small muted', e.notes));
        if (e.tags?.length) card.append(el('div', 'row wrap', ...e.tags.map((t) => el('span', 'tag', t))));
        listBox.append(card);
      }
    };
    draw(st.items || []);
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      draw((st.items || []).filter((e) => [e.service, e.username, e.url, e.notes, ...(e.tags || [])].join(' ').toLowerCase().includes(q)));
    });

    // add form
    const f = {};
    const mk = (k, ph, type = 'text') => {
      const i = el('input');
      i.placeholder = ph;
      i.type = type;
      f[k] = i;
      return i;
    };
    const genBtn = el('button', 'btn sm', 'generate');
    genBtn.onclick = async () => {
      const r = await api('/api/vault', { action: 'generate', options: { length: 22 } });
      f.password.value = r.password;
      f.password.type = 'text';
    };
    const save = el('button', 'btn primary', 'save entry');
    save.onclick = async () => {
      if (!f.service.value.trim()) return toast('service name required', 'err');
      const r = await api('/api/vault', {
        action: 'add',
        entry: {
          service: f.service.value,
          username: f.username.value,
          password: f.password.value,
          url: f.url.value,
          notes: f.notes.value,
          tags: f.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      if (!r.ok) return toast(r.error, 'err');
      toast('saved');
      refresh();
    };

    box.append(
      el('div', 'row', el('span', 'tag ok', 'unlocked'), el('span', 'small muted', `${st.items.length} entries`), el('span', 'grow'), bLock),
      el('div', 'row', search, bAdd),
      listBox,
      el('h3', '', 'Add entry'),
      el('div', 'split', mk('service', 'service (Discord, Gmail…)'), mk('username', 'username / email')),
      el('div', 'row', mk('password', 'password', 'password'), genBtn),
      el('div', 'split', mk('url', 'login URL'), mk('tags', 'tags, comma separated')),
      el('div', '', mk('notes', 'notes — recovery codes, which email you used where…')),
      el('div', 'row', el('span', 'grow'), save),
      el('h3', '', 'Encrypted backup'),
      backupBlock(),
    );
    bAdd.onclick = () => f.service.focus();
  }

  function backupBlock() {
    const wrap = el('div');
    const info = el('div', 'small faint', 'loading…');
    const go = el('button', 'btn primary', 'Backup now');
    const list = el('div');
    const reload = async () => {
      const r = await api('/api/backup');
      clear(info).append(
        el('span', 'tag ' + (r.googleConnected ? 'ok' : 'warn'), r.googleConnected ? 'google connected' : 'google not connected'),
        ' ',
        el('span', 'small muted', r.googleConnected ? 'uploads encrypted file to a hidden Drive folder' : 'local encrypted copies only — connect Google in Settings to mirror to Drive'),
      );
      clear(list);
      for (const f of (r.local || []).slice(0, 8)) {
        list.append(el('div', 'row card tight', el('span', 'mono small grow ellipsis', f.name), el('span', 'faint small', `${(f.bytes / 1024).toFixed(1)} KB`)));
      }
      if (r.drive?.files?.length) {
        list.append(el('div', 'small faint', `drive: ${r.drive.files.length} encrypted backup(s)`));
      }
    };
    go.onclick = async () => {
      go.disabled = true;
      go.textContent = 'sealing…';
      const r = await api('/api/backup', { upload: true });
      go.disabled = false;
      go.textContent = 'Backup now';
      if (!r.ok) return toast(r.error, 'err');
      toast(r.uploaded ? 'backed up to Drive' : 'backed up locally');
      reload();
    };
    wrap.append(el('div', 'row', info, el('span', 'grow'), go), list);
    reload();
    return wrap;
  }

  refresh();
}

/* ------------------------------- community app --------------------------- */
function renderCommunity(body) {
  clear(body);
  const d = state.discord || {};
  const s = state.settings?.discord || {};

  const brand = el('input');
  brand.placeholder = 'community name';
  brand.value = s.brand || '';
  const token = el('input');
  token.type = 'password';
  token.placeholder = 'bot token (Developer Portal → Bot → Reset Token)';
  token.value = s.token || '';
  const admins = el('input');
  admins.placeholder = 'admin channel IDs, comma separated';
  admins.value = (d.adminChannels || []).join(',');
  const members = el('input');
  members.placeholder = 'member channel IDs, comma separated';
  members.value = (d.memberChannels || []).join(',');

  const statusRow = el('div', 'row wrap');
  const logBox = el('div', 'pre');
  logBox.style.display = 'none';

  const save = el('button', 'btn sm', 'save');
  save.onclick = async () => {
    const r = await api('/api/discord', {
      action: 'save',
      discord: {
        token: token.value,
        brand: brand.value,
        adminChannels: admins.value.split(',').map((x) => x.trim()).filter(Boolean),
        memberChannels: members.value.split(',').map((x) => x.trim()).filter(Boolean),
      },
    });
    if (!r.ok) return toast(r.error, 'err');
    state.discord = r;
    toast('saved');
    drawStatus(r);
  };
  const startB = el('button', 'btn primary', 'start bot');
  startB.onclick = async () => {
    startB.disabled = true;
    startB.textContent = 'connecting…';
    const r = await api('/api/discord', { action: 'start' });
    startB.disabled = false;
    startB.textContent = 'start bot';
    if (!r.ok) return toast(r.error, 'err');
    drawStatus(r);
    toast('bot connected as ' + (r.botUser?.username || 'bot'));
  };
  const stopB = el('button', 'btn sm', 'stop');
  stopB.onclick = async () => {
    const r = await api('/api/discord', { action: 'stop' });
    drawStatus(r);
  };
  const testB = el('button', 'btn sm', 'test token');
  testB.onclick = async () => {
    const r = await api('/api/discord', { action: 'test' });
    r.ok ? toast('token valid · ' + r.username) : toast(r.error || 'failed', 'err');
  };

  function drawStatus(st) {
    clear(statusRow).append(
      el('span', 'tag ' + (st.running ? 'ok' : st.configured ? 'warn' : 'err'), st.running ? `online · ${st.botUser?.username || ''}` : st.configured ? 'configured, offline' : 'no token'),
      el('span', 'small faint', `intents ${st.intents || ''}`),
    );
    if (st.lastError) statusRow.append(el('span', 'tag err', String(st.lastError).slice(0, 90)));
  }
  drawStatus(d);

  const blueprint = `CHANNELS
  #welcome        read-only: what this is, 3 rules, link to #start-here
  #start-here     read-only: how to ask the bot, what it can do
  #general        chat
  #agent-chat     members talk to the agent (read-only mode, no commands)
  #show-and-tell  members post what they built
  #admin          PRIVATE, you only — full agent, can run commands

ROLES
  @Admin    you
  @Member   everyone
  @Bot      the agent; give it Send Messages + Read History in the channels above

RULES (pin in #welcome)
  1. Ask the agent anything — it cites sources and refuses to invent them.
  2. The agent cannot touch files or run commands for members. Only in #admin.
  3. No spam, no crypto, no scraping people's data.

ONBOARDING MESSAGE
  Welcome. This is a community around a local-first AI agent.
  Ask it in #agent-chat; it searches the live web and answers with sources.
  Want your own? Setup guide is pinned in #start-here.`;

  const copyBtn = el('button', 'btn sm', 'copy blueprint');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(blueprint);
    toast('blueprint copied');
  };

  body.append(
    el('div', 'card', el('b', '', 'Two trust levels, enforced by the tool policy'), el('div', 'small muted', 'Your DM / #admin → full agent. Every other channel → read-only: it can search and answer, but a write or a command is hard-denied before it runs — not just discouraged in the prompt.')),
    el('h3', '', 'Discord bot'),
    statusRow,
    el('div', 'split', brand, token),
    el('div', 'split', admins, members),
    el('div', 'row wrap', save, testB, startB, stopB),
    el('div', 'small faint', 'Bot setup: Discord Developer Portal → New Application → Bot → Reset Token → enable MESSAGE CONTENT INTENT → invite with scope bot + permissions Send Messages, Read Message History.'),
    el('h3', '', 'Server blueprint'),
    el('div', 'row', el('span', 'grow'), copyBtn),
    el('div', 'pre', blueprint),
    el('h3', '', 'Brand'),
    el('div', 'small faint', 'Name, one-line promise, and the three things it is not. Paste this everywhere — bio, invite, README.'),
    el('div', 'pre', `${brand.value || 'NEXUS'}\nAn agent that runs on your machine, not someone else's cloud.\n\nNot a chatbot. Not a wrapper. Not your data on a server.`),
  );
}

/* --------------------------------- brain app ------------------------------ */
function renderBrain(body) {
  clear(body);
  const statsRow = el('div', 'row wrap');
  const searchIn = el('input');
  searchIn.placeholder = 'ask your own brain… “kaggle deadlines”, “how do I run the pptx build”';
  const listBox = el('div');
  const profileBox = el('div');

  const syncBtn = el('button', 'btn sm', 'sync other agents');
  syncBtn.title = 'Read new sessions and instruction files from Codex and Claude Code on this machine';
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'reading…';
    const r = await api('/api/brain', { action: 'sync' });
    syncBtn.disabled = false;
    syncBtn.textContent = 'sync other agents';
    if (!r.ok) return toast(r.error, 'err');
    const added = (r.report || []).reduce((n, x) => n + (x.added || 0), 0);
    toast(`imported ${added} item(s)`);
    refresh();
  };

  async function refresh(q) {
    const r = await api('/api/brain' + (q ? '?q=' + encodeURIComponent(q) : ''));
    clear(statsRow).append(
      el('span', 'tag ok', `${r.stats.entries} memories`),
      el('span', 'small faint', Object.entries(r.stats.byKind).map(([k, v]) => `${k} ${v}`).join(' · ') || 'empty'),
      el('span', 'grow'),
      syncBtn,
    );
    clear(listBox);
    if (!r.items?.length) listBox.append(el('div', 'empty', 'nothing learned yet — add a fact below, or sync your other agents'));
    for (const it of r.items) {
      const card = el('div', 'card tight');
      const del = el('button', 'btn sm ghost', '✕');
      del.onclick = async () => {
        await api('/api/brain', { action: 'delete', id: it.id });
        refresh(searchIn.value);
      };
      card.append(
        el('div', 'row', el('span', 'tag', it.kind), el('b', 'ellipsis', it.title), el('span', 'grow'), el('span', 'faint small', (it.createdAt || '').slice(0, 10)), del),
        it.body && it.body !== it.title ? el('div', 'small muted', String(it.body).slice(0, 260)) : '',
        it.meta?.deadline ? el('div', 'small', el('span', 'tag warn', 'deadline ' + String(it.meta.deadline).slice(0, 10))) : '',
      );
      listBox.append(card);
    }

    clear(profileBox);
    const p = r.profile;
    const section = (title, rows) => {
      if (!rows?.length) return;
      profileBox.append(el('h3', '', title));
      for (const row of rows) profileBox.append(el('div', 'small muted', row));
    };
    section('You', p.preferences);
    section('Active projects', p.projects);
    section('Open tasks', p.openTasks);
    section('Competitions tracked', p.competitions);
    section('Recent decisions', p.decisions);
    if (!profileBox.firstChild) profileBox.append(el('div', 'small faint', 'The profile fills in as you work. The agent writes here whenever it learns something durable.'));
  }

  const kindSel = el('select');
  kindSel.style.width = 'auto';
  for (const k of ['fact', 'preference', 'project', 'task', 'decision', 'lesson', 'competition', 'person']) kindSel.append(el('option', '', k));
  const titleIn = el('input');
  titleIn.placeholder = 'what is true (short) — e.g. “Uses GEE for urban heat island work”';
  const bodyIn = el('textarea');
  bodyIn.placeholder = 'the detail the agent should remember';
  const tagsIn = el('input');
  tagsIn.placeholder = 'tags, comma separated';
  const deadlineIn = el('input');
  deadlineIn.placeholder = 'deadline (ISO, optional) — 2026-11-30';
  const addBtn = el('button', 'btn primary', 'store in brain');
  addBtn.onclick = async () => {
    if (!titleIn.value.trim() && !bodyIn.value.trim()) return;
    const r = await api('/api/brain', {
      action: 'add',
      entry: {
        kind: kindSel.value,
        title: titleIn.value || bodyIn.value.slice(0, 80),
        body: bodyIn.value,
        tags: tagsIn.value,
        deadline: deadlineIn.value || undefined,
        source: 'user',
        confidence: 'high',
      },
    });
    if (!r.ok) return toast(r.error, 'err');
    titleIn.value = '';
    bodyIn.value = '';
    tagsIn.value = '';
    toast('stored');
    refresh();
  };

  searchIn.addEventListener('input', () => refresh(searchIn.value));

  body.append(
    el('div', 'small faint', 'Local knowledge, one JSONL file, zero cloud. Injected into every prompt and queryable by the agent.'),
    statsRow,
    el('div', 'row', searchIn),
    el('h3', '', 'Memory'),
    listBox,
    el('h3', '', 'Profile'),
    profileBox,
    el('h3', '', 'Teach it something'),
    el('div', 'row', kindSel, titleIn),
    el('div', '', bodyIn),
    el('div', 'split', tagsIn, deadlineIn),
    el('div', 'row', el('span', 'grow'), addBtn),
  );
  refresh();
}

/* --------------------------------- intel app ------------------------------ */
function renderIntel(body) {
  clear(body);
  const hours = el('input');
  hours.type = 'number';
  hours.value = 10;
  hours.style.width = '80px';
  const skills = el('input');
  skills.placeholder = 'your skills: python, sql, pandas, gee, pptx, writing';
  const out = el('div');

  const find = el('button', 'btn primary', 'find opportunities');
  find.onclick = async () => {
    clear(out).append(el('div', 'empty', 'scanning competitions, bounties and gigs…'));
    const r = await api('/api/intel', { action: 'opportunities', hoursPerWeek: Number(hours.value) || 10, skills: skills.value });
    clear(out);
    if (!r.ok) return out.append(el('div', 'empty', r.error || 'failed'));
    if (!r.opportunities?.length) return out.append(el('div', 'empty', 'nothing found right now'));
    for (const o of r.opportunities) {
      const card = el('div', 'card tight');
      const a = el('a', '', o.title);
      a.href = o.url;
      a.target = '_blank';
      card.append(
        el('div', 'row', el('span', 'tag', o.kind), a, el('span', 'grow'), el('span', 'tag ' + (o.score >= 30 ? 'ok' : ''), 'score ' + o.score)),
        el('div', 'small faint', `${o.note || ''} · ${o.effortHours}h effort · ~$${o.hourly}/h implied · fit ${o.fit}%`),
      );
      out.append(card);
    }
  };

  const planBtn = el('button', 'btn', 'money plan');
  planBtn.onclick = async () => {
    const r = await api('/api/intel?hours=' + (Number(hours.value) || 10));
    clear(out);
    for (const lane of r.plan.lanes) {
      out.append(
        el('div', 'card',
          el('div', 'row', el('b', '', lane.lane), el('span', 'grow'), el('span', 'tag ok', lane.share + ' h/week')),
          el('div', 'small muted', lane.why),
          el('div', 'small', '→ ' + lane.firstStep),
        ),
      );
    }
    out.append(el('h3', '', 'Guardrails'));
    for (const g of r.plan.guardrails) out.append(el('div', 'small muted', '· ' + g));
    const savePlan = el('button', 'btn sm primary', 'save to brain');
    savePlan.onclick = async () => {
      const rr = await api('/api/intel', { action: 'save_plan', hoursPerWeek: Number(hours.value) || 10, skills: skills.value });
      rr.ok ? toast('plan stored — the agent will use it') : toast(rr.error || 'failed', 'err');
    };
    out.append(el('div', 'row', el('span', 'grow'), savePlan));
  };

  const rulesBtn = el('button', 'btn', 'platform rules');
  rulesBtn.onclick = async () => {
    const r = await api('/api/intel');
    clear(out);
    out.append(el('div', 'small faint', 'What gets an account banned is usually a policy rule, not a secret. Read it before automating.'));
    for (const p of r.rules) {
      out.append(
        el('div', 'card',
          el('b', '', p.platform),
          el('div', 'small', el('span', 'tag ok', 'fine'), ' ' + p.safe.join(' · ')),
          el('div', 'small', el('span', 'tag err', 'never'), ' ' + p.never.join(' · ')),
        ),
      );
    }
  };

  body.append(
    el('div', 'card',
      el('b', '', 'Where the money actually is'),
      el('div', 'small muted', 'Paid competitions, bounty-labelled GitHub issues, and contract leads — scored by implied hourly rate, fit to your skills, and whether it fits your week. No “guaranteed income” nonsense.'),
    ),
    el('div', 'row', el('span', 'small faint', 'hours/week'), hours, skills),
    el('div', 'row wrap', find, planBtn, rulesBtn),
    out,
  );
}

/* ------------------------------ browser (tabs) ---------------------------- */
function renderBrowser(body) {
  clear(body);
  const tabStrip = el('div', 'tabstrip');
  const statusRow = el('div', 'row wrap');
  const addr = el('input');
  addr.placeholder = 'https://…';
  addr.style.flex = '1';
  const view = el('div');
  const els = el('div', 'el-list');
  let tabs = [];
  let activeId = null;
  let live = null;

  const bLaunch = el('button', 'btn sm primary', 'open persistent Chrome');
  const bQuit = el('button', 'btn sm ghost', 'close browser');
  const bLive = el('button', 'btn sm', 'live view');
  const bGo = el('button', 'btn sm', 'open');

  async function shot() {
    const r = await api('/api/browser', { action: 'screenshot' });
    if (!r.ok) return;
    const img = el('img', 'shot');
    img.src = '/shots/' + r.file + '?t=' + Date.now();
    clear(view).append(img);
  }

  async function refreshTabs() {
    const r = await api('/api/browser', { action: 'tabs' });
    tabs = r.result?.tabs || [];
    if (!activeId && tabs.length) activeId = tabs[0].id;
    drawTabs();
    clear(statusRow).append(
      el('span', 'tag ' + (r.result ? 'ok' : 'err'), r.result ? `${tabs.length} tab(s) · :${state.settings?.browser?.port || 9222}` : 'not running'),
    );
    return tabs;
  }

  function drawTabs() {
    clear(tabStrip);
    for (const t of tabs) {
      const tab = el('div', 'tab' + (t.id === activeId ? ' on' : ''));
      const title = el('span', 'tab-title', (t.title || t.url || 'tab').slice(0, 30));
      title.onclick = () => select(t.id);
      const x = el('button', 'tab-x', '×');
      x.onclick = async (e) => {
        e.stopPropagation();
        await api('/api/browser', { action: 'close_tab', id: t.id });
        if (activeId === t.id) activeId = null;
        await refreshTabs();
        if (activeId) await loadTab();
      };
      tab.append(title, x);
      tabStrip.append(tab);
    }
    const add = el('button', 'tab tab-add', '+');
    add.title = 'new tab';
    add.onclick = async () => {
      const r = await api('/api/browser', { action: 'new_tab', url: addr.value || 'https://duckduckgo.com' });
      activeId = r.result?.id || activeId;
      await refreshTabs();
      await loadTab();
    };
    tabStrip.append(add);
  }

  async function select(id) {
    activeId = id;
    await api('/api/browser', { action: 'activate', id });
    drawTabs();
    await loadTab();
  }

  async function loadTab() {
    clear(els).append(el('div', 'empty', 'reading page…'));
    const s = await api('/api/browser', { action: 'snapshot' });
    if (!s.ok) {
      clear(els).append(el('div', 'empty', s.error || 'no page'));
      return;
    }
    const r = s.result;
    addr.value = r.url || '';
    clear(els).append(el('div', 'small faint', `${r.title || ''} · ${r.elements.length} interactive elements`));
    for (const e of r.elements.slice(0, 120)) {
      const row = el('div', 'el', el('span', 'i', String(e.i)), el('span', 't', `${e.tag}${e.type ? '·' + e.type : ''} — ${e.label || e.placeholder || e.href}`));
      row.onclick = () => {
        idx.value = e.i;
        if (['input', 'textarea', 'select'].includes(e.tag)) txt.focus();
      };
      els.append(row);
    }
    await shot();
  }

  const ctrl = el('div', 'row wrap');
  const idx = el('input');
  idx.placeholder = '#';
  idx.style.width = '70px';
  const txt = el('input');
  txt.placeholder = 'text to type';
  txt.style.flex = '1';
  const bClick = el('button', 'btn sm', 'click');
  const bType = el('button', 'btn sm', 'type');
  const key = el('input');
  key.placeholder = 'key (Enter, Tab, Ctrl+A…)';
  key.value = 'Enter';
  key.style.width = '190px';
  const bPress = el('button', 'btn sm', 'press key');
  const bDown = el('button', 'btn sm', '↓');
  ctrl.append(idx, txt, bClick, bType, key, bPress, bDown);

  bLaunch.onclick = async () => {
    toast('opening Chrome with the persistent Nexus profile…');
    const r = await api('/api/browser', { action: 'launch', url: addr.value || undefined });
    if (!r.ok) toast(r.error || 'failed', 'err');
    await refreshTabs();
    await loadTab();
  };
  bQuit.onclick = async () => {
    await api('/api/browser', { action: 'close' });
    clear(view);
    await refreshTabs();
  };
  bLive.onclick = () => {
    if (live) {
      clearInterval(live);
      live = null;
      bLive.textContent = 'live view';
      bLive.classList.remove('primary');
      return;
    }
    live = panelPoll(body, shot, 2500);
    bLive.textContent = 'live · on';
    bLive.classList.add('primary');
  };
  bGo.onclick = async () => {
    const r = await api('/api/browser', { action: 'open', url: addr.value });
    if (!r.ok) toast(r.error || 'failed', 'err');
    setTimeout(loadTab, 1100);
    setTimeout(refreshTabs, 1400);
  };
  bClick.onclick = async () => {
    const r = await api('/api/browser', { action: 'click', index: Number(idx.value) });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    setTimeout(async () => {
      await shot();
      await refreshTabs();
    }, 800);
  };
  bType.onclick = async () => {
    const r = await api('/api/browser', { action: 'type', index: Number(idx.value), text: txt.value });
    if (!r.ok) toast(r.error || 'failed', 'err');
    else setTimeout(shot, 400);
  };
  bPress.onclick = async () => {
    const r = await api('/api/browser', { action: 'press', key: key.value.trim() });
    if (!r.ok) return toast(r.error || 'keyboard action failed', 'err');
    setTimeout(async () => {
      await loadTab();
      await refreshTabs();
    }, 1300);
  };
  bDown.onclick = async () => {
    await api('/api/browser', { action: 'scroll', y: 700 });
    setTimeout(shot, 500);
  };

  body.append(
    el('div', 'row wrap', bLaunch, bLive, el('span', 'grow'), statusRow, bQuit),
    tabStrip,
    el('div', 'row', addr, bGo),
    view,
    el('div', 'small faint', 'Chrome uses a persistent Nexus profile for cookies and sign-ins. Save passwords only in Chrome/Edge Password Manager; Nexus does not store them. The lightweight built-in view has temporary cookies and cannot perform full logins. The agent can click, type, and press keys in this tab; sensitive actions still follow your approval settings.'),
    ctrl,
    els,
  );

  refreshTabs().then(async () => {
    if (tabs.length) await loadTab();
  });
}

/* --------------------------------- lab app -------------------------------- */
function renderLab(body) {
  clear(body);
  const cmd = el('input');
  cmd.placeholder = 'python make_deck.py --out deck.pptx';
  cmd.style.fontFamily = 'var(--mono)';
  const cwdIn = el('input');
  cwdIn.value = state.project || state.workspace || '';
  const label = el('input');
  label.placeholder = 'label (optional)';
  label.style.maxWidth = '180px';
  const runBtn = el('button', 'btn primary', 'run in background');

  const presets = el('div', 'row wrap');
  for (const p of [
    ['GEE check', 'python gee_automation.py check'],
    ['GEE NDVI', 'python gee_automation.py ndvi'],
    ['Build deck', 'python make_deck.py'],
    ['Kaggle status', 'python kaggle_status.py'],
    ['Poll kernel', 'python poll_kernel.py'],
    ['python version', 'python --version'],
  ]) {
    const b = el('button', 'btn sm ghost', p[0]);
    b.onclick = () => {
      cmd.value = p[1];
      cmd.focus();
    };
    presets.append(b);
  }

  const jobsBox = el('div');
  const logBox = el('div', 'logbox');
  const logHead = el('div', 'row small faint');
  let selected = null;
  let cursor = 0;
  let poll = null;

  function stopPoll() {
    if (poll) clearInterval(poll);
    poll = null;
  }

  async function openLog(id) {
    stopPoll();
    selected = id;
    cursor = 0;
    clear(logBox);
    clear(logHead);
    const r = await api('/api/jobs/' + id + '?since=0');
    if (!r.ok) return logBox.append(el('div', 'empty', r.error || 'failed'));
    logHead.append(el('b', '', r.label), el('span', 'grow'), el('span', 'tag ' + (r.status === 'running' ? 'warn' : r.status === 'done' ? 'ok' : 'err'), r.status), el('span', 'faint mono', r.id));
    appendLines(r.lines);
    if (r.status === 'running') {
      poll = panelPoll(body, async () => {
        const n = await api('/api/jobs/' + id + '?since=' + cursor);
        if (!n.ok) return;
        appendLines(n.lines);
        if (n.status !== 'running') {
          stopPoll();
          refreshJobs();
        }
      }, 900);
    }
  }

  function appendLines(lines) {
    for (const l of lines || []) {
      const row = el('div', 'logline' + (l.stream === 'err' ? ' err' : ''), l.text === '' ? ' ' : l.text);
      logBox.append(row);
      cursor++;
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function refreshJobs() {
    const r = await api('/api/jobs');
    clear(jobsBox);
    if (!r.jobs?.length) return jobsBox.append(el('div', 'empty', 'no jobs yet — run something above'));
    for (const j of r.jobs) {
      const row = el('div', 'jobrow' + (j.id === selected ? ' on' : ''));
      const dur = j.endedAt ? Math.round((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000) + 's' : 'running';
      const pct = j.percent != null ? ` · ${j.percent}%` : '';
      const open = el('div', 'row grow', el('span', 'tag ' + (j.status === 'running' ? 'warn' : j.status === 'done' ? 'ok' : 'err'), j.status), el('b', 'ellipsis', j.label), el('span', 'faint small mono', dur + pct));
      open.style.cursor = 'pointer';
      open.onclick = () => openLog(j.id);
      row.append(open);
      if (j.status === 'running') {
        const k = el('button', 'btn sm danger', 'kill');
        k.onclick = async (e) => {
          e.stopPropagation();
          await api('/api/jobs', { action: 'kill', id: j.id });
          refreshJobs();
        };
        row.append(k);
      } else if (j.logFile) {
        const l = el('button', 'btn sm ghost', 'log');
        l.onclick = (e) => {
          e.stopPropagation();
          openLog(j.id);
        };
        row.append(l);
      }
      jobsBox.append(row);
    }
  }

  runBtn.onclick = async () => {
    if (!cmd.value.trim()) return;
    const r = await api('/api/jobs', { action: 'start', command: cmd.value, cwd: cwdIn.value, label: label.value });
    if (!r.ok) return toast(r.error, 'err');
    toast('job started · ' + r.job.id);
    await refreshJobs();
    openLog(r.job.id);
  };

  const artBox = el('div');
  async function refreshArtifacts() {
    const r = await api('/api/artifacts');
    clear(artBox);
    const items = (r.items || []).slice(0, 30);
    if (!items.length) return artBox.append(el('div', 'empty', 'nothing here yet'));
    for (const it of items) {
      const row = el('div', 'row card tight');
      row.append(
        el('span', 'tag ' + (it.kind === 'image' ? 'ok' : it.kind === 'office' ? 'warn' : ''), it.kind),
        el('span', 'small ellipsis grow', it.name),
        el('span', 'faint small mono', (it.bytes / 1024).toFixed(0) + ' KB'),
      );
      const viewBtn = el('button', 'btn sm ghost', it.kind === 'image' ? 'preview' : 'open');
      viewBtn.onclick = () => window.open('/api/artifact?path=' + encodeURIComponent(it.path), '_blank');
      row.append(viewBtn);
      artBox.append(row);
    }
  }

  const refreshAll = el('button', 'btn sm ghost', 'refresh');
  refreshAll.onclick = () => {
    refreshJobs();
    refreshArtifacts();
  };

  body.append(
    el('div', 'card', el('b', '', 'Runs that outlive the chat'), el('div', 'small muted', 'A normal command dies when the request ends. These keep running, keep their whole log, and can be killed with the whole process tree — which is what GEE exports, Kaggle polling and deck builds need.')),
    el('div', 'row', cmd, runBtn),
    el('div', 'row', cwdIn, label),
    presets,
    el('h3', '', 'Jobs'),
    jobsBox,
    logHead,
    logBox,
    el('h3', '', 'Recent files'),
    artBox,
    el('div', 'row', el('span', 'grow'), refreshAll),
  );
  refreshJobs();
  refreshArtifacts();
}

/* ------------------------------- files v2 -------------------------------- */
function renderFiles(body) {
  clear(body);
  const stage = el('div');
  const tabs = el('div', 'row wrap');
  let mode = 'browse';
  let cwd = state.project || state.workspace || '';

  const tab = (id, label) => {
    const b = el('button', 'btn sm' + (mode === id ? ' primary' : ''), label);
    b.onclick = () => {
      mode = id;
      $$('.btn', tabs).forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      draw();
    };
    return b;
  };
  tabs.append(tab('browse', 'Browse'), tab('search', 'Search my PC'), tab('suggest', 'Suggestions'), tab('collections', 'Projects'));

  async function draw() {
    clear(stage);
    if (mode === 'browse') return drawBrowse();
    if (mode === 'search') return drawSearch();
    if (mode === 'suggest') return drawSuggest();
    return drawCollections();
  }

  async function drawBrowse() {
    const pathIn = el('input');
    pathIn.value = cwd;
    const go = el('button', 'btn sm', 'go');
    const up = el('button', 'btn sm ghost', '↑ up');
    up.onclick = () => {
      const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
      parts.pop();
      cwd = parts.join('\\') || cwd;
      drawBrowse();
    };
    go.onclick = () => {
      cwd = pathIn.value;
      drawBrowse();
    };
    const list = el('div');
    const prev = el('div');
    stage.append(el('div', 'row wrap', pathIn, go, up), list, prev);

    const r = await api('/api/fs/list', { dir: cwd });
    if (!r.ok) return list.append(el('div', 'empty', r.error || 'cannot read folder'));
    cwd = r.path;
    pathIn.value = cwd;
    for (const it of r.items || []) {
      const row = el('div', 'filerow');
      const name = el('span', 'grow ellipsis', (it.dir ? '▸ ' : '· ') + it.name);
      name.style.cursor = 'pointer';
      name.onclick = async () => {
        if (it.dir) {
          cwd = r.path + '\\' + it.name;
          drawBrowse();
          return;
        }
        const full = r.path + '\\' + it.name;
        const ext = it.name.slice(it.name.lastIndexOf('.')).toLowerCase();
        clear(prev);
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
          const img = el('img', 'shot');
          img.src = '/api/artifact?path=' + encodeURIComponent(full);
          prev.append(img);
        } else if (['.txt', '.md', '.py', '.js', '.json', '.csv', '.log', '.yml', '.html', '.css'].includes(ext)) {
          const t = await api('/api/fs/read', { path: full });
          prev.append(el('div', 'pre', String((t.text || t.error || '').slice(0, 3000))));
        } else {
          const card = el('div', 'card tight', el('b', '', it.name));
          card.append(el('div', 'small muted', `${(it.size / 1024).toFixed(0)} KB · ${ext}`));
          const row = el('div', 'row');
          const openWin = el('button', 'btn sm', 'open with Windows');
          openWin.onclick = () => api('/api/shell', { command: `Invoke-Item '${full}'` });
          const askBtn = el('button', 'btn sm', 'ask agent about it');
          askBtn.onclick = () => {
            openApp('chat');
  refreshWorkspacePill();
  refreshActionCenterBadge();
  renderWallpaperBriefing();

            setTimeout(() => wins.get('chat')?.sendToChat?.(`Read ${full} and tell me what it is.`), 200);
          };
          row.append(openWin, askBtn);
          card.append(row);
          prev.append(card);
        }
      };
      const del = el('button', 'btn sm ghost', '→ bin');      del.title = 'move to Recycle Bin';
      del.onclick = async () => {
        if (!confirm(`Move to Recycle Bin?\n\n${it.name}`)) return;
        const rr = await api('/api/fs/trash', { path: r.path + '\\' + it.name });
        rr.ok ? toast('moved to Recycle Bin') : toast(rr.error || 'failed', 'err');
        drawBrowse();
      };
      row.append(name, el('span', 'faint small mono', it.dir ? 'dir' : `${(it.size / 1024).toFixed(0)} KB`), (() => {
        const v = el('button', 'btn sm ghost', 'view');
        v.onclick = () => openPreview(r.path + '\\' + it.name);
        return v;
      })(), del);
      list.append(row);
    }
    if (!(r.items || []).length) list.append(el('div', 'empty', 'empty folder'));
  }

  async function drawSearch() {
    const q = el('input');
    q.placeholder = 'file name or folder — searched across the whole PC index';
    const go = el('button', 'btn sm primary', 'search');
    const scan = el('button', 'btn sm ghost', 'index my PC');
    const stat = el('div', 'small faint');
    const out = el('div');
    stage.append(el('div', 'row', q, go, scan), stat, out);

    const showStats = async () => {
      const r = await api('/api/index');
      const s = r.stats;
      clear(stat).append(el('span', 'small faint', `${s.files} files indexed · ${(s.bytes / 1e9).toFixed(1)} GB`), el('span', 'small faint', s.scan?.running ? ` · scanning ${s.scan.scanned}…` : ''));
      return s;
    };
    scan.onclick = async () => {
      await api('/api/index', { action: 'scan' });
      toast('indexing in the background');
      const t = panelPoll(body, async () => {
        const s = await showStats();
        if (!s.scan?.running) clearInterval(t);
      }, 1500);
    };
    const run = async () => {
      clear(out);
      const r = await api('/api/index', { action: 'search', q: q.value });
      if (!r.items?.length) return out.append(el('div', 'empty', 'no match — try indexing first, or a shorter word'));
      for (const f of r.items.slice(0, 60)) {
        const row = el('div', 'filerow');
        const open = el('button', 'btn sm ghost', 'open');
        open.onclick = async () => {
          const ext = f.ext;
          if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) window.open('/api/artifact?path=' + encodeURIComponent(f.path), '_blank');
          else {
            const t = await api('/api/fs/read', { path: f.path });
            out.prepend(el('div', 'pre', String((t.text || t.error || '').slice(0, 2000))));
          }
        };
        const ask = el('button', 'btn sm ghost', 'ask');
        ask.onclick = () => { openApp('chat'); setTimeout(() => wins.get('chat')?.sendToChat?.(`Look at ${f.path} and summarise what it contains.`), 200); };
        row.append(el('span', 'grow ellipsis', f.name), el('span', 'faint small mono', `${(f.bytes / 1024).toFixed(0)}KB`), el('span', 'faint small mono ellipsis', f.path.slice(0, 48)), open, ask);
        out.append(row);
      }
    };
    go.onclick = run;
    q.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    showStats();
    setTimeout(() => q.focus(), 60);
  }

  async function drawSuggest() {
    const r = await api('/api/index', { action: 'suggestions' });
    if (!r.items?.length) return stage.append(el('div', 'empty', 'Index your PC first — nothing to suggest yet.'));
    stage.append(el('div', 'small faint', 'Each suggestion can be handed straight to the agent. Nothing runs without your approval.'));
    for (const s of r.items) {
      const card = el('div', 'card');
      card.append(el('div', 'row', el('span', 'tag ' + (s.severity === 'medium' ? 'warn' : 'ok'), s.severity), el('b', '', s.title)), el('div', 'small muted', s.detail || ''));
      const act = el('button', 'btn sm primary', 'ask agent to handle it');
      act.onclick = () => {
        openApp('chat');
        setTimeout(() => wins.get('chat')?.sendToChat?.(`From my PC index: ${s.title}. ${s.detail || ''} Suggest and carry out the safest fix, asking me before anything destructive.`), 200);
      };
      card.append(el('div', 'row', el('span', 'grow'), act));
      stage.append(card);
    }
  }

  async function drawCollections() {
    const r = await api('/api/index', { action: 'collections' });
    if (!r.items?.length) return stage.append(el('div', 'empty', 'Index your PC to see project folders grouped automatically.'));
    for (const c of r.items.slice(0, 40)) {
      const row = el('div', 'filerow');
      const open = el('button', 'btn sm ghost', 'open');
      open.onclick = () => { cwd = c.dir; mode = 'browse'; draw(); };
      row.append(el('span', 'tag', c.kind), el('span', 'grow ellipsis small', c.dir), el('span', 'faint small mono', `${c.files} files · ${c.mb} MB`), open);
      stage.append(row);
    }
  }

  body.append(tabs, stage);
  draw();
}

/* --------------------------------- radar app ----------------------------- */
function renderRadar(body, category = 'opportunity') {
  clear(body);
  const competitions = category === 'competition';
  const head = el('div', 'row wrap');
  const sourceBox = el('div', 'row wrap');
  const out = el('div');
  const dig = el('div');
  const scanBtn = el('button', 'btn primary', competitions ? 'scan competitions now' : 'scan global opportunities');
  const sched = el('button', 'btn sm', 'schedule daily 07:00');
  head.append(scanBtn, sched, el('span', 'grow'));

  body.append(
    el('div', 'card',
      el('b', '', competitions ? 'Worldwide competitions' : 'Global opportunities'),
      el('div', 'small muted', competitions
        ? 'Competition discovery includes Kaggle, Devpost, Amazon Science, NASA Space Apps, DrivenData, Zindi, Copernicus Masters, and geoinformatics, Earth-observation, climate, and environmental-science challenges. Verify official rules and deadlines.'
        : 'Separate from contests: find research grants, fellowships, funded PhD and research-assistant roles, assistant-professor positions, public support, tenders, and paid work worldwide. Verify eligibility and official deadlines.'),
    ),
    sourceBox,
    head,
    dig,
    out,
  );

  async function loadSaved() {
    const r = await api('/api/radar?category=' + category);
    clear(sourceBox).append(el('span', 'small faint', 'tracked source groups:'));
    for (const source of r.sources || []) sourceBox.append(el('span', 'tag', source.label));
    clear(out);
    const items = r.items || [];
    if (!items.length) return out.append(el('div', 'empty', 'nothing yet — run a scan'));
    for (const i of items) {
      const m = i.meta || {};
      const card = el('div', 'card tight');
      card.append(
        el('div', 'row', el('span', 'tag ' + (m.region === 'IN' ? 'ok' : ''), m.region || '—'), el('b', 'ellipsis', i.title), el('span', 'grow')),
        el('div', 'small muted', String(i.body || '').split('\n')[0]),
        el('div', 'row',
          m.deadline ? el('span', 'tag warn', 'due ' + m.deadline) : '',
          m.prize ? el('span', 'tag', m.prize) : '',
          el('span', 'grow'),
          (() => { const b = el('button', 'btn sm ghost', 'dive'); b.onclick = async () => { const d = await api('/api/radar', { action: 'dive', url: m.url }); card.append(el('div', 'pre tight', JSON.stringify(d, null, 2).slice(0, 1200))); }; return b; })(),
          (() => { const b = el('button', 'btn sm', 'open in browser'); b.onclick = async () => { await api('/api/browser', { action: 'open', url: m.url }); openApp('browser'); }; return b; })(),
          (() => { const b = el('button', 'btn sm ghost', 'plan it'); b.onclick = () => { openApp('chat'); setTimeout(() => wins.get('chat')?.sendToChat?.(`Opportunity: ${i.title} (${m.url}). Deadline ${m.deadline || 'unknown'}. Check eligibility, then plan the smallest viable submission for me.`), 200); }; return b; })(),
        ),
      );
      out.append(card);
    }
  }

  scanBtn.onclick = async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = competitions ? 'scanning competition sources…' : 'scanning opportunity sources…';
    const r = await api('/api/radar', { category });
    scanBtn.disabled = false;
    scanBtn.textContent = competitions ? 'scan competitions now' : 'scan global opportunities';
    if (!r.ok) return toast(r.error || 'scan failed', 'err');
    clear(dig).append(
      el('div', 'pre', r.digest || ''),
      r.errors?.length ? el('div', 'small', el('span', 'tag warn', `${r.errors.length} source(s) unavailable`), ' Some sources could not be reached; results may be incomplete.') : '',
    );
    toast(`${r.items.length} found · ${r.saved} new`);
    loadSaved();
  };

  sched.onclick = async () => {
    const r = await api('/api/tasks', {
      when: 'daily 07:00',
      label: competitions ? 'Global competition radar' : 'Global opportunities radar',
      prompt: competitions
        ? 'Find current worldwide competitions and challenges, including Kaggle, Devpost, Amazon Science/AWS research challenges, NASA Space Apps, DrivenData, Zindi, Copernicus Masters, and geoinformatics, Earth-observation, climate, and environmental-science competitions. Verify each on its official source; report eligibility, rules, deadline, prize/funding, required skills/data/compute, effort, and the lowest-hassle next action. Do not promise a win or submit without approval.'
        : 'Find global opportunities separate from contests: research grants, fellowships, funded PhD and research-assistant roles, assistant-professor positions, government support, tenders, and paid work. Prioritize geoinformatics, Earth observation, remote sensing, environmental science, and climate research while remaining open to other fields. Verify official eligibility, location, dates, funding/salary, application requirements, and costs. Cite official sources, rank by fit and effort, and do not apply or promise income.',
    });
    r.ok ? toast('scheduled for 07:00 daily') : toast(r.error || 'failed', 'err');
  };

  loadSaved();
}

function renderGlobalIntel(body, win) {
  clear(body);
  const stage = el('div', 'global-intel-stage');
  const tabs = el('div', 'global-intel-tabs');
  const tabDefs = [
    ['radar', 'Global opportunities'],
    ['competitions', 'Competitions'],
    ['business', 'Business intelligence'],
    ['earning', 'Earn + learn'],
    ['geo', 'Geospatial intelligence'],
    ['news', 'News + policy'],
    ['markets', 'Markets · paper only'],
  ];
  let activeTab = 'radar';
  const tabButtons = new Map();
  const submitTask = (text) => {
    if (!String(text || '').trim()) return toast('Describe what you want Nexus to research or build.', 'warn');
    openApp('chat');
    setTimeout(() => wins.get('chat')?.sendToChat?.(text), 220);
  };
  const tabButton = (id, label) => {
    const b = el('button', 'btn sm' + (activeTab === id ? ' primary' : ''), label);
    b.onclick = () => selectTab(id);
    tabButtons.set(id, b);
    return b;
  };
  const selectTab = (id) => {
    if (!tabDefs.some(([key]) => key === id)) return;
    activeTab = id;
    for (const [key, b] of tabButtons) b.classList.toggle('primary', key === id);
    clear(stage);
    if (id === 'radar') return renderRadar(stage, 'opportunity');
    if (id === 'competitions') return renderRadar(stage, 'competition');
    if (id === 'business') {
      renderIntel(stage);
      stage.prepend(el('div', 'card',
        el('b', '', 'Business intelligence and public support'),
        el('div', 'small muted', 'Research customer demand, competitors, grants, company programs, procurement, jobs/contracts, setup costs, and legal or licensing requirements from official sources.'),
        (() => {
          const b = el('button', 'btn sm', 'find support and practical alternatives');
          b.onclick = () => submitTask('Research practical business and public-support opportunities that fit my skills and location. Search official government schemes and grants, big-company startup/creator programs, procurement/tenders, accelerators, paid contracts, and research support. For each, verify the official source, eligibility, location, dates, setup/licensing needs, costs, risks, and a low-hassle validation step. Keep competitions in the separate Competitions tab. Cite sources; do not promise income, apply, or spend without approval.');
          return b;
        })(),
      ));
      return;
    }
    if (id === 'earning') return renderEarning(stage);
    if (id === 'news') return renderNews(stage);
    if (id === 'markets') return renderMarkets(stage);
    if (id === 'geo') return renderGeo(stage);
  };
  win.selectTab = selectTab;

  const connect = el('button', 'btn sm', 'Gmail + Drive');
  connect.onclick = () => openApp('connect');
  const gmail = el('button', 'btn sm ghost', 'Inbox');
  gmail.onclick = () => openApp('mail');
  const drive = el('button', 'btn sm ghost', 'Drive');
  drive.onclick = () => openApp('drive');
  const browser = el('button', 'btn sm ghost', 'Browser');
  browser.onclick = () => openApp('browser');
  const ask = el('input');
  ask.placeholder = 'Ask Nexus to research a subject, opportunity, location, or idea';
  const askButton = el('button', 'btn primary', 'Research with Nexus');
  askButton.onclick = () => {
    if (!ask.value.trim()) return toast('Describe a topic or outcome first.', 'warn');
    submitTask(
      `Research this request globally: ${ask.value.trim()}. Use current web sources, prioritize official or primary evidence, compare options and eligibility, cite URLs and dates, state uncertainty, and end with the lowest-hassle next action. Do not spend money, send messages, apply, or submit anything without my approval.`,
    );
  };
  ask.addEventListener('keydown', (e) => { if (e.key === 'Enter') askButton.click(); });

  body.append(
    el('div', 'global-intel-hero',
      el('div', 'welcome-mark', '◈'),
      el('div', '', el('h2', '', 'Nexus Global Intelligence'), el('div', 'small muted', 'A guided research cockpit for worldwide competitions, grants and academic roles, business, geospatial science, jobs, learning, and markets.')),
    ),
    el('div', 'row wrap global-intel-access', connect, gmail, drive, browser),
    el('div', 'row global-intel-ask', ask, askButton),
    tabs,
    stage,
    el('div', 'small faint', 'Nexus ranks evidence and proposes next steps; it cannot guarantee income or exhaustive discovery. Approval remains required before external actions or spending.'),
  );
  for (const [id, label] of tabDefs) tabs.append(tabButton(id, label));

  function renderNews(host) {
    clear(host);
    const report = el('div', 'pre');
    const refresh = el('button', 'btn sm ghost', 'refresh saved briefing');
    refresh.onclick = load;
    const topic = el('select');
    for (const name of ['Global overview', 'AI and technology', 'Business and economy', 'Politics and public policy', 'Government support and grants', 'Science, energy and climate', 'Geospatial and Earth observation']) {
      topic.append(el('option', '', name));
    }
    const research = el('button', 'btn sm primary', 'research latest');
    research.onclick = () => submitTask(
      `Research the latest global news and opportunities in ${topic.value}. Use credible recent sources and official sources for policies, grants, and schemes. Summarize what changed, who may benefit, eligibility or risks, practical implications for research/career/business, and cite dates and URLs. Separate verified facts from analysis; do not claim guaranteed earnings.`,
    );
    host.append(
      el('div', 'card', el('b', '', 'Global briefing'), el('div', 'small muted', 'Saved daily intelligence, plus on-demand source-backed research across subjects.')),
      el('div', 'row wrap', topic, research, refresh),
      report,
    );
    async function load() {
      report.textContent = 'Loading saved briefing…';
      const r = await api('/api/briefing');
      report.textContent = r.has && r.briefing ? r.briefing : 'No saved briefing yet. Choose a topic and ask Nexus to research it.';
    }
    load();
  }

  function renderGeo(host) {
    clear(host);
    const area = el('input');
    area.placeholder = 'Study area or country (optional)';
    const goal = el('input');
    goal.placeholder = 'Goal: crop health, flood risk, urban heat, land cover…';
    const build = el('button', 'btn primary', 'Research + build pipeline');
    build.onclick = () => submitTask(
      `Plan a geospatial analysis${area.value.trim() ? ` for ${area.value.trim()}` : ''}${goal.value.trim() ? ` focused on ${goal.value.trim()}` : ''}. Research current official Google Earth Engine and dataset documentation, compare suitable datasets, explain coverage/resolution/limits, then build a reproducible Python Earth Engine API pipeline with authentication/setup, preprocessing, validation, export, and a small test. Ask for missing critical inputs rather than inventing them. Do not start paid exports or services without approval.`,
    );
    const browserBtn = el('button', 'btn sm ghost', 'Research in browser');
    browserBtn.onclick = () => openApp('browser');
    const labBtn = el('button', 'btn sm ghost', 'Open Python Lab');
    labBtn.onclick = () => openApp('lab');
    host.append(
      el('div', 'card', el('b', '', 'Geospatial intelligence'), el('div', 'small muted', 'Use the same agent to research Earth Engine datasets, write Python pipelines, validate outputs, and prepare export steps. Actual execution requires your GEE credentials, installed libraries, and an approved task.')),
      el('div', 'split', area, goal),
      el('div', 'row wrap', build, browserBtn, labBtn),
      el('div', 'small faint', 'Typical workflows: NDVI/time series, crop monitoring, land cover, flood exposure, urban heat, and change detection.'),
    );
  }

  function renderEarning(host) {
    clear(host);
    const region = el('input');
    region.placeholder = 'Preferred country or region (optional; worldwide by default)';
    const skills = el('input');
    skills.placeholder = 'Skills or interests (optional): Python, AI/ML, GIS…';
    const cards = el('div', 'agent-grid');
    const lanes = [
      ['AI/ML jobs and contracts', 'Find roles, internships, apprenticeships, and paid projects on official employer or platform pages.', 'AI/ML data science jobs remote worldwide hiring internships entry level official careers'],
      ['Research and academic careers', 'Find funded PhD, research assistant, postdoc, and assistant-professor opportunities.', 'funded PhD research assistant postdoc assistant professor geoinformatics environmental science AI climate official university'],
      ['Large-company programs and AI services', 'Check real startup, cloud-credit, creator, partner, and small-business programs, plus services that can be validated cheaply.', 'large technology company startup program cloud credits AI partner program creator side hustle official eligibility'],
      ['AI-assisted digital products', 'Research demand and platform rules for useful templates, design assets, datasets, and learning products; check rights and licensing.', 'sell AI-assisted digital assets templates design assets creator marketplace platform policies licensing demand'],
      ['Free learning and portfolio plan', 'Build a practical learning path from free official courses and open data to one verifiable portfolio project.', 'free official AI machine learning geospatial Earth observation environmental science courses portfolio project'],
    ];
    for (const [title, detail, query] of lanes) {
      const card = el('div', 'card');
      const action = el('button', 'btn sm primary', 'research this lane');
      action.onclick = () => submitTask(
        `Research this earning-and-learning lane globally: ${title}. Search current official sources${region.value.trim() ? ` relevant to ${region.value.trim()}` : ' worldwide'}; consider these topics: ${query}. My skills/interests: ${skills.value.trim() || 'not specified'}. Compare eligibility, compensation or costs, deadlines, time to first result, required skills, platform rules, copyright/licensing, risks, and evidence of demand. Give realistic alternatives and one low-cost next step; cite dated URLs. Do not promise income, fabricate results, apply, publish, or spend without approval.`,
      );
      card.append(el('b', '', title), el('div', 'small muted', detail), action);
      cards.append(card);
    }
    host.append(
      el('div', 'card', el('b', '', 'Earn + learn pathways'), el('div', 'small muted', 'Explore multiple routes without assuming they will earn money. Nexus compares evidence, effort, eligibility, risks, and a small validation step.')),
      el('div', 'split', region, skills),
      cards,
    );
  }

  function renderMarkets(host) {
    clear(host);
    const market = el('input');
    market.placeholder = 'Market or asset class (optional): index, FX, crypto, commodities…';
    const idea = el('input');
    idea.placeholder = 'Research goal or strategy hypothesis (optional)';
    const research = el('button', 'btn sm primary', 'research market data and risks');
    research.onclick = () => submitTask(
      `Research market data and trading risks for ${market.value.trim() || 'the requested market'}${idea.value.trim() ? `; hypothesis: ${idea.value.trim()}` : ''}. Use reputable, current sources; separate historical evidence from speculation; explain fees, slippage, liquidity, drawdowns, overfitting, and uncertainty. This is education/research, not personalized financial advice. Do not place trades or request broker credentials.`,
    );
    const backtest = el('button', 'btn sm', 'design a paper-trading backtest');
    backtest.onclick = () => submitTask(
      `Design a reproducible paper-trading/backtesting workflow for ${market.value.trim() || 'a market I specify'}${idea.value.trim() ? ` using this hypothesis: ${idea.value.trim()}` : ''}. Use public/historical data, chronological train/test splits, fees and slippage, benchmark comparisons, risk limits, drawdown reporting, and a paper-only execution simulator. Identify data licensing and failure modes. Do not connect a broker, place live orders, or claim future returns.`,
    );
    const monitor = el('button', 'btn sm ghost', 'plan a non-trading alert');
    monitor.onclick = () => submitTask(
      `Plan a read-only market/news alert for ${market.value.trim() || 'a market I specify'}${idea.value.trim() ? ` related to ${idea.value.trim()}` : ''}. Use documented public sources and rate limits; define the alert threshold, data timestamp, false-positive risks, and an audit log. It must not place orders or give a guaranteed-profit signal.`,
    );
    host.append(
      el('div', 'card', el('b', '', 'Markets and trading research — paper only'), el('div', 'small muted', 'Nexus can research markets, build backtests, and simulate alerts. This workspace does not connect to a broker or place real-money trades.')),
      el('div', 'split', market, idea),
      el('div', 'row wrap', research, backtest, monitor),
      el('div', 'small faint', 'Do not paste broker credentials or treat backtests as forecasts. Validate strategies independently before any real-world decision.'),
    );
  }

  selectTab('radar');
}

function openPreview(filePath) {
  openApp('viewer', filePath);
}

/* -------------------------------- viewer app ------------------------------ */
function renderViewer(body, win) {
  const stage = el('div');
  body.append(stage);

  async function draw(p) {
    clear(stage);
    if (!p) return stage.append(el('div', 'empty', 'no file selected — open one from Files or a chat artifact'));
    const name = String(p).split(/[\\/]/).pop();
    const head = el('div', 'row wrap');
    const openWin = el('button', 'btn sm ghost', 'open with Windows');
    openWin.onclick = () => api('/api/shell', { command: `Invoke-Item '${p}'` });
    const reveal = el('button', 'btn sm ghost', 'show in folder');
    reveal.onclick = async () => {
      const r = await api('/api/reveal', { path: p });
      r.ok ? toast('opened Explorer') : toast(r.error || 'failed', 'err');
    };
    const reload = el('button', 'btn sm', 'reload');
    reload.onclick = () => draw(p);
    head.append(el('b', 'ellipsis', name), el('span', 'grow'), reload, reveal, openWin);
    stage.append(head, el('div', 'small faint mono', p));

    const r = await api('/api/preview?path=' + encodeURIComponent(p));
    if (!r.ok) return stage.append(el('div', 'empty', r.error || 'cannot preview this file'));

    stage.append(
      el('div', 'row wrap',
        el('span', 'tag ok', r.kind || 'file'),
        el('span', 'small faint', `${(r.bytes / 1024).toFixed(0)} KB`),
        el('span', 'small faint', r.at ? new Date(r.at).toLocaleString() : ''),
        r.meta?.slides ? el('span', 'tag', `${r.meta.slides} slides`) : '',
        r.meta?.notes ? el('span', 'tag', `${r.meta.notes} notes`) : '',
        r.lines ? el('span', 'tag', `${r.lines} lines`) : '',
      ),
    );

    if (r.thumbs?.length) {
      const strip = el('div', 'slidestrip');
      r.thumbs.forEach((u, i) => {
        const wrap = el('div', 'slidewrap');
        const img = el('img', 'slideimg');
        img.src = u;
        img.loading = 'lazy';
        wrap.append(img, el('div', 'small faint', `slide ${i + 1}`));
        strip.append(wrap);
      });
      stage.append(el('div', 'small faint', 'rendered by your installed PowerPoint'), strip);
    } else if (r.thumbsError) {
      stage.append(el('div', 'small faint', 'slide render unavailable: ' + r.thumbsError));
    }

    if (r.url) {
      const img = el('img', 'shot');
      img.src = r.url;
      stage.append(img);
    } else if (r.text) {
      stage.append(el('div', 'pre', r.text));
    } else if (r.note) {
      stage.append(el('div', 'empty', r.note));
    }
  }

  win.draw = draw;
  win.argPath = win.argPath || '';
  draw(win.argPath);
}

/* --------------------------------- skills v2 ----------------------------- */
function renderSkills(body) {
  clear(body);
  const head = el('div', 'row wrap');
  const listBox = el('div');
  const reader = el('div');

  const enableAll = el('button', 'btn sm primary', 'enable all');
  enableAll.onclick = async () => {
    await api('/api/skills', { action: 'enable_all' });
    toast('all skills enabled');
    refresh();
  };
  head.append(el('span', 'small faint', 'skills are prompt instructions — they change how the agent works'), el('span', 'grow'), enableAll);

  async function refresh() {
    const r = await api('/api/skills');
    state.skills = r.skills || [];
    const on = state.skills.filter((s) => s.enabled).length;
    clear(head).append(el('span', 'tag ok', `${on}/${state.skills.length} enabled`), el('span', 'grow'), enableAll);
    clear(listBox);
    for (const s of state.skills) {
      const card = el('div', 'card tight');
      const sw = el('div', 'switch' + (s.enabled ? ' on' : ''));
      sw.onclick = async () => {
        sw.classList.toggle('on');
        await api('/api/skills', { action: 'toggle', id: s.id, on: sw.classList.contains('on') });
        refresh();
      };
      const read = el('button', 'btn sm ghost', 'read');
      read.onclick = async () => {
        const rr = await api('/api/skills', { action: 'read', id: s.id });
        clear(reader).append(el('div', 'pre', rr.skill?.body || ''));
      };
      card.append(
        el('div', 'row', el('b', '', s.name), el('span', 'badge', `${s.chars} chars`), el('span', 'grow'), read, sw),
        el('div', 'small muted', s.description || ''),
      );
      listBox.append(card);
    }
    if (!state.skills.length) listBox.append(el('div', 'empty', 'no skills installed'));
  }

  // --- install from the web ---
  const urlIn = el('input');
  urlIn.placeholder = 'https://raw.githubusercontent.com/…/SKILL.md';
  const previewBtn = el('button', 'btn sm', 'check');
  const previewOut = el('div');
  let staged = null;

  previewBtn.onclick = async () => {
    clear(previewOut).append(el('div', 'empty', 'fetching and scanning…'));
    const r = await api('/api/skills', { action: 'fetch', url: urlIn.value.trim() });
    clear(previewOut);
    if (!r.ok) return previewOut.append(el('div', 'empty', r.error || 'fetch failed'));
    staged = r;
    previewOut.append(
      el('div', 'card',
        el('div', 'row', el('b', '', r.name || 'unnamed'), el('span', 'badge', `${r.chars} chars`), el('span', 'grow')),
        el('div', 'small muted', r.description || '(no description)'),
        r.warnings.length
          ? el('div', '', el('div', 'small', el('span', 'tag err', 'risky')), ...r.warnings.map((w) => el('div', 'small', '· ' + w.label + '  ' + (w.sample ? `“${w.sample}”` : ''))))
          : el('div', 'small', el('span', 'tag ok', 'scan clean'), ' no instruction-override or credential patterns found'),
      ),
      el('div', 'pre tight', r.preview),
    );
    const install = el('button', 'btn sm ' + (r.warnings.length ? '' : 'primary'), r.warnings.length ? 'install anyway (stays disabled)' : 'install');
    install.onclick = async () => {
      const rr = await api('/api/skills', { action: 'install_url', url: staged.url, id: staged.suggestedId, enable: false });
      rr.ok ? toast(rr.note || 'installed') : toast(rr.error || 'failed', 'err');
      refresh();
    };
    const installOn = el('button', 'btn sm ghost', 'install + enable');
    installOn.disabled = Boolean(r.warnings.length);
    installOn.title = r.warnings.length ? 'blocked while warnings are present' : 'install and turn it on';
    installOn.onclick = async () => {
      const rr = await api('/api/skills', { action: 'install_url', url: staged.url, id: staged.suggestedId, enable: true });
      rr.ok ? toast('installed and enabled') : toast(rr.error || 'failed', 'err');
      refresh();
    };
    previewOut.append(el('div', 'row wrap', install, installOn));
  };

  // --- discover ---
  const qIn = el('input');
  qIn.placeholder = 'find skills: powerpoint, excel, research, kaggle…';
  const findBtn = el('button', 'btn sm', 'search web');
  const findOut = el('div');
  findBtn.onclick = async () => {
    clear(findOut).append(el('div', 'empty', 'searching…'));
    const r = await api('/api/skills', { action: 'discover', q: qIn.value });
    clear(findOut);
    if (!r.items?.length) return findOut.append(el('div', 'empty', 'nothing found — try different words, or paste a raw SKILL.md URL'));
    for (const it of r.items) {
      const row = el('div', 'card tight');
      const a = el('a', '', it.title || it.url);
      a.href = it.url;
      a.target = '_blank';
      row.append(a, el('div', 'small muted', it.snippet || ''));
      const use = el('button', 'btn sm ghost', 'use this URL');
      use.onclick = () => {
        urlIn.value = it.url;
        previewBtn.click();
      };
      row.append(el('div', 'row', it.likelyRaw ? el('span', 'tag ok', 'raw') : el('span', 'tag warn', 'open the raw file first'), el('span', 'grow'), use));
      findOut.append(row);
    }
  };

  const searchShortcuts = el('div', 'row wrap');
  for (const query of ['Google Drive', 'Gmail', 'Google Docs', 'PowerPoint', 'Google Sheets']) {
    const shortcut = el('button', 'btn sm ghost', query);
    shortcut.onclick = () => {
      qIn.value = query;
      findBtn.click();
    };
    searchShortcuts.append(shortcut);
  }

  const workspaceSkills = el('div', 'workspace-skills');
  const startTask = (promptText) => {
    openApp('chat');
    setTimeout(() => wins.get('chat')?.sendToChat?.(promptText), 220);
  };
  const tasks = [
    {
      title: 'Gmail inbox triage',
      detail: 'Find important recent mail and summarize action items. Read-only; no messages are sent.',
      prompt: 'Use the inbox-triage skill and my connected Gmail to find recent messages that need my attention. Summarize the sender, subject, date, and requested action. Do not send, delete, archive, or modify any email.',
    },
    {
      title: 'Drive and Google Docs research',
      detail: 'Search Drive, read relevant Docs, and cite filenames. No edits.',
      prompt: 'Use the deep-research skill if enabled and search my connected Google Drive for documents about the topic I give you. If I have not given a topic, ask me first. Read only relevant files, cite their filenames and available links, and summarize the evidence. Do not edit or share files.',
    },
    {
      title: 'Prepare an email reply',
      detail: 'Draft a response in chat for review; do not send it.',
      prompt: 'Ask me which Gmail message to reply to if I have not identified one. Read that message and prepare a concise reply draft in chat. Do not send or save the draft.',
    },
    {
      title: 'Analyze a Google Sheet',
      detail: 'Read the spreadsheet and explain trends; no changes to cells.',
      prompt: 'Use the spreadsheets skill if enabled. Ask me which Google Sheet and question to analyze if either is missing. Read the relevant data, explain your method and findings, and do not write to or change the spreadsheet.',
    },
    {
      title: 'Create a Word report (.docx)',
      detail: 'Uses the office-docs skill to create and verify a local Word file. Nothing is uploaded or shared.',
      prompt: 'Use the office-docs skill to create a Word .docx deliverable. Ask for the topic, audience, or required source material if missing. Save a new file under the Nexus workspace, verify the file exists and read its text back. Do not upload or share it. If python-docx is unavailable, report that and ask before installing anything.',
    },
  ];
  for (const task of tasks) {
    const card = el('div', 'card tight');
    const use = el('button', 'btn sm', 'start');
    use.onclick = () => startTask(task.prompt);
    card.append(el('div', 'row', el('b', '', task.title), el('span', 'grow'), use), el('div', 'small muted', task.detail));
    workspaceSkills.append(card);
  }
  const deckCard = el('div', 'card tight');
  const createDeck = el('button', 'btn sm primary', 'start PPTX task');
  createDeck.onclick = () => startTask('Use the office-decks skill to create a PowerPoint .pptx. Ask for the topic, audience, and desired length if missing. Save a new file under the Nexus workspace, verify it exists and report the slide count. Do not upload or share it; do not install packages without asking first.');
  const openDecks = el('button', 'btn sm primary', 'open presentation builder');
  openDecks.onclick = () => openApp('decks');
  deckCard.append(
    el('div', 'row wrap', el('b', '', 'PowerPoint presentation'), el('span', 'grow'), createDeck, openDecks),
    el('div', 'small muted', 'The office-decks skill verifies local PPTX output; the presentation builder also has a lecture-deck workflow. Drive upload is not automatic.'),
  );
  workspaceSkills.append(deckCard);
  const connectGoogle = el('button', 'btn sm ghost', 'Google connection settings');
  connectGoogle.onclick = () => openApp('connect');

  body.append(
    head,
    el('div', 'card', el('div', 'row', el('b', '', 'Google Workspace quick skills'), el('span', 'grow'), connectGoogle), el('div', 'small muted', 'Connect once in Connections. Gmail, Drive, Docs, and Sheets use the Google account you choose; review generated content before sending or sharing.'), workspaceSkills),
    listBox,
    el('h3', '', 'Install from the web'),
    el('div', 'small faint', 'Paste a link to a SKILL.md. It is scanned for instruction-override and credential patterns, and installed DISABLED so you can read it first.'),
    el('div', 'row', urlIn, previewBtn),
    previewOut,
    el('h3', '', 'Find skills for your workflow'),
    el('div', 'small faint', 'Search results are third-party instructions. Review the source and scanner warnings; installs stay disabled until you explicitly enable them.'),
    searchShortcuts,
    el('div', 'row', qIn, findBtn),
    findOut,
    el('h3', '', 'Reader'),
    reader,
  );
  refresh();
}

/* ------------------------------ providers app ---------------------------- */
function renderProviders(body) {
  clear(body);
  const listBox = el('div');
  const presetRow = el('div', 'row wrap');
  const discoBox = el('div');
  const credentialNote = el('div');
  const refreshProviders = el('button', 'btn sm ghost', 'refresh providers');
  refreshProviders.onclick = () => { refresh(); loadState(); };
  const visionProvider = el('select');
  const visionOnly = el('input');
  visionOnly.type = 'checkbox';
  const quickMode = el('select');
  quickMode.append(el('option', '', 'Local Ollama'), el('option', '', 'Cloud API'));
  quickMode.options[0].value = 'ollama';
  quickMode.options[1].value = 'openai';
  const quickEndpoint = el('input');
  quickEndpoint.placeholder = 'http://127.0.0.1:11434 or cloud API base URL';
  const quickModel = el('input');
  quickModel.placeholder = 'model id';
  const quickKey = el('input');
  quickKey.type = 'password';
  quickKey.placeholder = 'Cloud API key (leave blank to keep saved key)';
  const quickKeyField = el('label', 'field', el('span', '', 'API key'), quickKey);
  const quickStatus = el('div', 'small muted');
  const quickResults = el('div');
  let quickProfiles = [];
  let quickActiveId = '';

  const f = { presetId: { value: '' }, supportsVision: el('input') };
  f.supportsVision.type = 'checkbox';
  const mk = (k, ph, type = 'text') => {
    const i = el('input');
    i.placeholder = ph;
    i.type = type;
    f[k] = i;
    return i;
  };

  async function refresh() {
    const r = await api('/api/providers');
    quickProfiles = r.profiles || [];
    const active = quickProfiles.find((p) => p.active);
    quickActiveId = active?.id || '';
    quickMode.value = active?.kind === 'ollama' ? 'ollama' : 'openai';
    quickEndpoint.value = active?.baseUrl || (quickMode.value === 'ollama' ? 'http://127.0.0.1:11434' : '');
    quickModel.value = active?.model || state.settings?.model || '';
    const reusableActiveKey = active?.hasKey && !['legacy-plaintext', 'vault-legacy', 'os-secure-unavailable'].includes(active.keyStorage);
    quickKey.placeholder = reusableActiveKey ? 'Key saved securely; leave blank to keep it' : 'Paste cloud API key';
    quickKeyField.hidden = quickMode.value !== 'openai';
    if (r.storageMode === 'os-secure') {
      quickStatus.textContent = 'Cloud keys are protected by Windows secure storage.';
    } else if (r.storageMode === 'session-only') {
      quickStatus.textContent = 'Cloud keys are session-only here; use the desktop app to save them securely.';
    } else {
      quickStatus.textContent = 'Windows secure storage is unavailable; new cloud keys will not be saved.';
    }
    if (active?.kind === 'ollama' && /-cloud(?::[^:]*)?$/.test(active.model || '')) {
      quickStatus.textContent = 'This model runs in Ollama Cloud through the local Ollama service; account limits may apply.';
    }
    clear(visionProvider);
    visionProvider.append(el('option', '', 'Ollama local (private)'));
    visionProvider.lastChild.value = 'ollama';
    for (const p of r.profiles || []) {
      if (!p.supportsVision) continue;
      const option = el('option', '', `${p.label} · ${p.model}`);
      option.value = p.id;
      visionProvider.append(option);
    }
    visionProvider.value = state.settings?.visionProviderId || 'ollama';
    clear(listBox);
    clear(credentialNote);
    if (r.storageMode === 'os-secure') {
      credentialNote.append(el('div', 'small muted', 'Cloud API keys are encrypted with Windows secure storage. They are never saved in settings.json.'));
    } else if (r.storageMode === 'session-only') {
      credentialNote.append(el('div', 'small muted', 'This browser/server mode keeps new API keys in memory until Nexus closes. Use the desktop app to save keys with Windows secure storage.'));
    } else {
      credentialNote.append(el('div', 'small muted', 'Windows secure storage is unavailable. Nexus will not save a new cloud API key.'));
    }
    const hasLegacyKeys = (r.profiles || []).some((p) => ['legacy-plaintext', 'vault-legacy'].includes(p.keyStorage));
    if (hasLegacyKeys) {
      credentialNote.append(el('div', 'small muted', 'A provider still has an older key. Re-enter its cloud API key here to move it to secure storage.'));
    }
    for (const p of r.profiles || []) {
      const card = el('div', 'card tight');
      const testDetails = el('div');
      const test = el('button', 'btn sm ghost', 'test');
      test.onclick = async () => {
        test.disabled = true;
        test.textContent = '…';
        const t = await api('/api/providers', { action: 'test', id: p.id });
        test.disabled = false;
        test.textContent = 'test';
        toast(t.ok ? `ok · ${t.ms}ms` : `failed: ${t.error}`, t.ok ? '' : 'err');
        clear(testDetails);
        if (t.ok && t.note) testDetails.append(el('div', 'small faint', t.note));
        if (t.ok && t.models?.length) {
          const picker = el('select');
          picker.style.width = 'auto';
          for (const model of t.models) picker.append(el('option', '', model));
          if (p.model && t.models.includes(p.model)) picker.value = p.model;
          const choose = el('button', 'btn sm', 'use model');
          choose.onclick = async () => {
            const updated = await api('/api/providers', { action: 'update', profile: { id: p.id, model: picker.value } });
            if (!updated.ok) return toast(updated.error || 'could not save model', 'err');
            toast('model saved');
            refresh();
            loadState();
          };
          testDetails.append(el('div', 'row', el('span', 'small faint', 'Available models'), picker, choose));
        }
      };
      const act = el('button', 'btn sm ' + (p.active ? '' : 'primary'), p.active ? 'active' : 'use this');
      act.onclick = async () => {
        if (!p.model) return toast('Test this provider and choose a model first', 'err');
        await api('/api/providers', { action: 'activate', id: p.id });
        toast('switched to ' + p.label);
        refresh();
        loadState();
      };
      const del = el('button', 'btn sm ghost', '✕');
      del.onclick = async () => {
        await api('/api/providers', { action: 'remove', id: p.id });
        refresh();
        loadState();
      };
      const keyStatus = {
        'os-secure': ' · Windows-secured key',
        'os-secure-unavailable': ' · use the desktop app to unlock this key',
        'session-only': ' · key for this session only',
        'vault-legacy': ' · legacy Vault key; re-enter to migrate',
        'legacy-plaintext': ' · legacy key; relaunch desktop to secure it',
      }[p.keyStorage] || '';
      card.append(
        el('div', 'row', el('span', 'tag ' + (p.active ? 'ok' : ''), p.active ? 'active' : 'standby'), el('b', '', p.label), el('span', 'small faint ellipsis', p.model || 'choose a model'), el('span', 'grow'), test, act, del),
        el('div', 'small faint mono', p.baseUrl + keyStatus),
        testDetails,
      );
      listBox.append(card);
    }
    if (!(r.profiles || []).length) listBox.append(el('div', 'empty', 'No providers yet — add one below to get started.'));

    clear(presetRow);
    for (const pre of r.presets || []) {
      const b = el('button', 'btn sm', pre.label);
      b.title = pre.note || '';
      b.onclick = () => {
        f.label.value = pre.label;
        f.baseUrl.value = pre.baseUrl;
        f.model.value = pre.model;
        kindSel.value = pre.kind;
        f.presetId.value = pre.id;
        f.supportsVision.checked = pre.supportsVision === true;
        f.apiKey.focus();
      };
      presetRow.append(b);
    }
  }

  const kindSel = el('select');
  kindSel.style.width = 'auto';
  kindSel.append(el('option', '', 'Cloud API'), el('option', '', 'Local Ollama'));
  kindSel.options[0].value = 'openai';
  kindSel.options[1].value = 'ollama';

  const add = el('button', 'btn primary', 'save provider');
  add.onclick = async () => {
    if (!f.baseUrl.value.trim()) return toast('base URL is required', 'err');
    let localEndpoint = false;
    try { localEndpoint = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(f.baseUrl.value.trim()).hostname); } catch {}
    if (!localEndpoint && !f.apiKey.value.trim()) return toast('enter the cloud API key here; it will be protected by Windows secure storage in the desktop app', 'err');
    const r = await api('/api/providers', {
      action: 'add',
      profile: { label: f.label.value || 'provider', baseUrl: f.baseUrl.value, model: f.model.value, apiKey: f.apiKey.value, kind: kindSel.value, presetId: f.presetId.value, supportsVision: f.supportsVision.checked },
    });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    toast(r.storageMode === 'os-secure' ? 'provider saved; API key protected by Windows' : f.apiKey.value ? 'provider saved for this session; use the desktop app to keep its key' : 'provider saved');
    f.apiKey.value = '';
    refresh();
    loadState();
  };

  const disco = el('button', 'btn sm', 'find free models (OpenRouter)');
  disco.onclick = async () => {
    clear(discoBox).append(el('div', 'empty', 'asking OpenRouter for its catalogue…'));
    const r = await api('/api/providers', { action: 'discover', visionOnly: visionOnly.checked });
    clear(discoBox);
    if (!r.ok) return discoBox.append(el('div', 'empty', r.error || 'failed'));
    discoBox.append(el('div', 'small faint', `${r.free} free models · ${r.visionFree} image-capable · sorted by context length. Free quotas and listings change.`));
    for (const m of (r.models || []).slice(0, 40)) {
      const row = el('div', 'filerow');
      const use = el('button', 'btn sm ghost', 'use');
      use.onclick = () => {
        f.label.value = 'OpenRouter';
        f.baseUrl.value = 'https://openrouter.ai/api/v1';
        f.model.value = m.id;
        kindSel.value = 'openai';
        f.presetId.value = 'openrouter';
        f.supportsVision.checked = m.supportsVision;
        toast('filled — paste your OpenRouter key, then save');
        f.apiKey.focus();
      };
      row.append(el('span', 'grow ellipsis', m.name || m.id), el('span', 'faint small mono', `${Math.round((m.context || 0) / 1000)}k${m.supportsVision ? ' · vision' : ''}${m.supportsTools ? ' · tools' : ''}`), use);
      discoBox.append(row);
    }
  };

  const saveVisionProvider = el('button', 'btn sm', 'save vision provider');
  saveVisionProvider.onclick = async () => {
    const r = await api('/api/settings', { visionProviderId: visionProvider.value });
    if (!r.ok) return toast(r.error || 'failed to save vision provider', 'err');
    toast(visionProvider.value === 'ollama' ? 'screenshots stay on this PC' : 'screenshots will be sent to the selected provider');
    loadState();
  };
  const remoteFallback = el('input');
  remoteFallback.type = 'checkbox';
  remoteFallback.checked = state.settings?.routing?.allowRemoteFallback === true;
  const saveFallback = el('button', 'btn sm', 'save routing privacy');
  saveFallback.onclick = async () => {
    const current = state.settings?.routing || {};
    const r = await api('/api/settings', { routing: { ...current, allowRemoteFallback: remoteFallback.checked } });
    if (!r.ok) return toast(r.error || 'failed to save routing settings', 'err');
    toast(remoteFallback.checked ? 'remote failover enabled' : 'remote failover disabled');
    loadState();
  };
  const localFallbackEnabled = el('input');
  localFallbackEnabled.type = 'checkbox';
  localFallbackEnabled.checked = state.settings?.routing?.localFallbackEnabled === true;
  const localFallbackModel = el('input');
  localFallbackModel.value = state.settings?.routing?.localFallbackModel || 'qwen2.5:7b';
  localFallbackModel.placeholder = 'local Ollama model, e.g. qwen2.5:7b';
  const saveLocalFallback = el('button', 'btn sm', 'save local fallback');
  saveLocalFallback.onclick = async () => {
    if (localFallbackEnabled.checked && !localFallbackModel.value.trim()) return toast('local fallback model is required', 'err');
    const current = state.settings?.routing || {};
    const r = await api('/api/settings', {
      routing: {
        ...current,
        localFallbackEnabled: localFallbackEnabled.checked,
        localFallbackModel: localFallbackModel.value.trim() || current.localFallbackModel || 'qwen2.5:7b',
      },
    });
    if (!r.ok) return toast(r.error || 'failed to save local fallback', 'err');
    toast(localFallbackEnabled.checked ? 'local Ollama fallback enabled' : 'local Ollama fallback disabled');
    loadState();
  };

  const temperature = el('input');
  temperature.type = 'number';
  temperature.min = '0';
  temperature.max = '2';
  temperature.step = '0.1';
  temperature.value = String(state.settings?.temperature ?? 0.4);
  const maxSteps = el('input');
  maxSteps.type = 'number';
  maxSteps.min = '1';
  maxSteps.max = '20';
  maxSteps.step = '1';
  maxSteps.value = String(state.settings?.maxSteps ?? 14);
  const saveGeneration = el('button', 'btn sm primary', 'save generation settings');
  saveGeneration.onclick = async () => {
    const t = Number(temperature.value);
    const steps = Number(maxSteps.value);
    if (!Number.isFinite(t) || t < 0 || t > 2) return toast('temperature must be between 0 and 2', 'err');
    if (!Number.isInteger(steps) || steps < 1 || steps > 20) return toast('agent steps must be an integer from 1 to 20', 'err');
    const r = await api('/api/settings', { temperature: t, maxSteps: steps });
    if (!r.ok) return toast(r.error || 'could not save generation settings', 'err');
    state.settings = r.settings;
    toast('generation settings saved');
  };
  quickMode.onchange = () => {
    quickKeyField.hidden = quickMode.value !== 'openai';
    quickStatus.textContent = quickMode.value === 'ollama'
      ? 'Local Ollama needs no API key. Model names ending in -cloud use your Ollama Cloud account.'
      : 'Use your provider’s OpenAI-compatible API URL, model ID, and API key.';
  };
  const saveQuickModel = el('button', 'btn primary', 'save and test');
  saveQuickModel.onclick = async () => {
    const kind = quickMode.value;
    const endpoint = quickEndpoint.value.trim();
    const model = quickModel.value.trim();
    const current = quickProfiles.find((p) => p.id === quickActiveId);
    const reusableKey = current?.hasKey && !['legacy-plaintext', 'vault-legacy', 'os-secure-unavailable'].includes(current.keyStorage);
    if (!endpoint) return toast('enter the model service URL', 'err');
    if (!model) return toast('enter a model ID', 'err');
    if (kind === 'openai' && !quickKey.value.trim() && !reusableKey) {
      return toast('enter the cloud API key', 'err');
    }
    const saved = await api('/api/providers', {
      action: quickActiveId ? 'update' : 'add',
      profile: {
        ...(quickActiveId ? { id: quickActiveId } : {}),
        label: kind === 'ollama' ? 'Ollama' : current?.kind === 'openai' ? current.label : 'Cloud API',
        kind,
        baseUrl: endpoint,
        model,
        apiKey: quickKey.value,
        activate: true,
        supportsVision: current?.supportsVision === true,
      },
    });
    if (!saved.ok) return toast(saved.error || 'could not save model settings', 'err');
    quickActiveId = saved.profile.id;
    quickKey.value = '';
    quickStatus.textContent = saved.storageMode === 'os-secure'
      ? 'Saved. Cloud API key is protected by Windows secure storage.'
      : kind === 'openai'
        ? 'Saved for this session only. Use the desktop app to persist the cloud key securely.'
        : 'Saved. Checking the selected model service…';
    clear(quickResults).append(el('div', 'small muted', 'Checking connection and available models…'));
    const testResult = await api('/api/providers', { action: 'test', id: quickActiveId });
    clear(quickResults);
    if (!testResult.ok) {
      quickResults.append(el('div', 'small', `Connection check failed: ${testResult.error || 'provider unavailable'}`));
    } else {
      quickResults.append(el('div', 'small', testResult.note || `Connected in ${testResult.ms}ms.`));
      if (testResult.models?.length) {
        const picker = el('select');
        for (const available of testResult.models) picker.append(el('option', '', available));
        if (testResult.models.includes(model)) picker.value = model;
        const useModel = el('button', 'btn sm', 'use selected model');
        useModel.onclick = async () => {
          const updated = await api('/api/providers', {
            action: 'update',
            profile: { id: quickActiveId, model: picker.value, activate: true },
          });
          if (!updated.ok) return toast(updated.error || 'could not select model', 'err');
          quickModel.value = picker.value;
          toast('model selected');
          refresh();
          loadState();
        };
        quickResults.append(el('div', 'row wrap', picker, useModel));
      }
    }
    refresh();
    loadState();
  };
  const advanced = el('details');
  advanced.append(
    el('summary', '', 'More options: saved providers, vision, routing, and model discovery'),
    el('div', 'card', el('b', '', 'Local Ollama or a cloud API'), el('div', 'small muted', 'Local Ollama needs no API key. Cloud API keys are encrypted by Windows in the desktop app; browser/server mode keeps them only for the current session.'), refreshProviders, credentialNote),
    listBox,
    el('div', 'card tight', el('b', '', 'Screenshot / vision provider'), el('div', 'small muted', 'Ollama keeps screenshots on this PC. Selecting a hosted provider sends page screenshots to that provider.'), visionProvider, saveVisionProvider),
    el('div', 'card tight', el('label', 'row', remoteFallback, el('span', '', 'Allow remote fallback for chat prompts')), el('div', 'small muted', 'Remote providers may receive prompts and relevant context. Free quotas vary; turn this on only if you accept that data transfer.'), saveFallback),
    el('div', 'card tight', el('label', 'row', localFallbackEnabled, el('span', '', 'Use local Ollama as fallback')), el('div', 'small muted', 'Off by default. When enabled, Nexus can retry a failed provider with this local model. This does not enable remote failover.'), localFallbackModel, saveLocalFallback),
    el('h3', '', 'Add from a preset'),
    presetRow,
    el('div', 'split', mk('label', 'label (Groq, OpenRouter…)'), mk('model', 'model id (can be chosen after saving)')),
    el('div', 'split', mk('baseUrl', 'local Ollama URL or cloud API endpoint'), mk('apiKey', 'cloud API key (blank for local Ollama)', 'password')),
    el('label', 'row', f.supportsVision, el('span', '', 'This provider/model supports image input')),
    el('div', 'row', kindSel, el('span', 'grow'), add),
    el('div', 'small faint', 'Testing checks the provider’s model catalogue without sending a generation prompt. For services that do not expose /models, use their documented model ID.'),
    el('h3', '', 'Free models'),
    el('label', 'row', visionOnly, el('span', '', 'Show only image-capable models')),
    el('div', 'row', disco),
    discoBox,
  );
  const ollamaDownload = el('a', 'small', 'Install Ollama');
  ollamaDownload.href = 'https://ollama.com/download';
  ollamaDownload.target = '_blank';
  ollamaDownload.rel = 'noopener noreferrer';
  body.append(
    el('div', 'card', el('b', '', 'Active model'), el('div', 'small muted', state.modelLabel || 'No active model selected yet.')),
    el('h3', '', 'Connect a model'),
    el('div', 'card',
      el('div', 'small muted', 'Choose one path. Local Ollama needs no API key; cloud providers need an endpoint, model ID, and key.'),
      el('label', 'field', el('span', '', 'Connection'), quickMode),
      el('div', 'split',
        el('label', 'field', el('span', '', 'Service URL'), quickEndpoint),
        el('label', 'field', el('span', '', 'Model ID'), quickModel),
      ),
      quickKeyField,
      el('div', 'row wrap', saveQuickModel, ollamaDownload),
      quickStatus,
      quickResults,
    ),
    el('h3', '', 'Generation'),
    el('div', 'split',
      el('label', 'field', el('span', '', 'Temperature'), temperature, el('div', 'small faint', 'Lower is more predictable; higher is more varied.')),
      el('label', 'field', el('span', '', 'Agent steps'), maxSteps, el('div', 'small faint', 'Maximum reasoning/tool loop steps per request (policy limits still apply).')),
    ),
    el('div', 'row', el('span', 'grow'), saveGeneration),
    advanced,
  );
  refresh();
}

function applyUi(ui = {}) {
  const t = ui.theme || 'aurora';
  const d = ui.density || 'comfortable';
  const a = ui.accent || 'mint';
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.density = d;
  document.documentElement.dataset.accent = a;
}

/* ------------------------------ appearance app ---------------------------- */
const THEMES = [
  { id: 'aurora', label: 'Aurora', note: 'mint on near-black — default' },
  { id: 'midnight', label: 'Midnight', note: 'blue, coolest of the four' },
  { id: 'ember', label: 'Ember', note: 'amber, easier at night' },
  { id: 'mono', label: 'Mono', note: 'neutral greys, zero colour' },
  { id: 'white', label: 'White', note: 'SGVU paper — true light theme for daylight and projection' },
];
const ACCENTS = ['mint', 'blue', 'violet', 'amber'];

function renderAppearance(body) {
  clear(body);
  const ui = (state.settings && state.settings.ui) || {};
  let { theme = 'aurora', density = 'comfortable', accent = 'mint' } = ui;

  const status = el('div', 'small faint');
  const save = async () => {
    const r = await api('/api/settings', { ui: { theme, density, accent } });
    if (r.ok) {
      state.settings = r.settings;
      applyUi({ theme, density, accent });
      status.textContent = `saved · ${theme} · ${density} · ${accent}`;
    } else status.textContent = r.error || 'failed';
  };

  const cards = {};
  const grid = el('div', 'agent-grid');
  for (const t of THEMES) {
    const card = el('div', 'mode-card' + (theme === t.id ? ' on' : ''));
    card.append(el('div', 'mode-head', el('b', '', t.label), el('span', 'grow'), theme === t.id ? el('span', 'tag ok', 'active') : ''));
    card.append(el('div', 'small muted', t.note));
    card.onclick = () => {
      theme = t.id;
      Object.entries(cards).forEach(([k, c]) => {
        c.classList.toggle('on', k === t.id);
        c.querySelector('.tag')?.remove();
        if (k === t.id) c.querySelector('.mode-head').append(el('span', 'tag ok', 'active'));
      });
      applyUi({ theme, density, accent });
      save();
    };
    cards[t.id] = card;
    grid.append(card);
  }

  const densityRow = el('div', 'row wrap');
  for (const d of ['comfortable', 'compact']) {
    const b = el('button', 'btn sm' + (density === d ? ' primary' : ''), d);
    b.onclick = () => {
      density = d;
      $$('.btn', densityRow).forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      applyUi({ theme, density, accent });
      save();
    };
    densityRow.append(b);
  }

  const accentRow = el('div', 'row wrap');
  for (const a of ACCENTS) {
    const b = el('button', 'btn sm' + (accent === a ? ' primary' : ''), a);
    b.onclick = () => {
      accent = a;
      $$('.btn', accentRow).forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      applyUi({ theme, density, accent });
      save();
    };
    accentRow.append(b);
  }

  body.append(
    el('div', 'card', el('b', '', 'Theme'), el('div', 'small muted', 'Applies immediately and is remembered. White is a genuine light theme — paper background, dark ink, projection-safe; the other four stay dark for evening work.')),
    grid,
    el('h3', '', 'Density'),
    el('div', 'small faint', 'Compact fits noticeably more on a 1366×768 laptop screen.'),
    densityRow,
    el('h3', '', 'Accent'),
    accentRow,
    el('div', 'row', status, el('span', 'grow')),
  );
  status.textContent = `current · ${theme} · ${density} · ${accent}`;
}

/* ------------------------------- MCP servers ----------------------------- */
function renderMcp(body) {
  clear(body);
  const serversBox = el('div');
  const catalogBox = el('div');
  const output = el('div');
  const refreshButton = el('button', 'btn sm ghost', 'refresh status');
  const openBrowser = el('button', 'btn sm', 'open persistent browser');
  openBrowser.onclick = () => openApp('browser');
  refreshButton.onclick = refresh;

  async function refresh() {
    const r = await api('/api/mcp');
    clear(serversBox);
    clear(catalogBox);
    if (!r.ok) {
      serversBox.append(el('div', 'empty', r.error || 'could not load MCP servers'));
      return;
    }

    if (!(r.servers || []).length) serversBox.append(el('div', 'empty', 'No MCP servers connected yet.'));
    for (const server of r.servers || []) {
      const card = el('div', 'card tight');
      const remove = el('button', 'btn sm ghost', 'remove');
      remove.onclick = async () => {
        if (!confirm(`Remove MCP server “${server.name}”?`)) return;
        const removed = await api('/api/mcp', { action: 'remove', name: server.name });
        if (!removed.ok) return toast(removed.error || 'could not remove MCP server', 'err');
        toast('MCP server removed');
        refresh();
      };
      card.append(
        el('div', 'row', el('span', 'tag ' + (server.running ? 'ok' : 'warn'), server.running ? 'running' : server.enabled ? 'stopped' : 'disabled'), el('b', '', server.name), el('span', 'grow'), remove),
        el('div', 'small faint mono', server.command),
      );
      if (server.tools?.length) {
        card.append(el('div', 'small muted', `${server.tools.length} tools: ${server.tools.map((tool) => tool.name).join(', ')}`));
      }
      if (server.error) card.append(el('div', 'small', el('span', 'tag err', 'error'), ' ', server.error));
      serversBox.append(card);
    }

    for (const preset of r.catalog || []) {
      const install = el('button', 'btn sm ' + (preset.installed ? '' : 'primary'), preset.installed ? 'installed' : 'connect');
      install.disabled = preset.installed;
      install.title = preset.note || '';
      install.onclick = async () => {
        if (!confirm(`Install and run ${preset.label}?\n\n${preset.note || ''}\n\nMCP servers execute locally and may access resources you authorize.`)) return;
        install.disabled = true;
        install.textContent = 'starting…';
        clear(output).append(el('div', 'small faint', `Starting ${preset.label}; a first run may download software.`));
        const result = await api('/api/mcp', { action: 'install', id: preset.id });
        if (!result.ok) {
          install.disabled = false;
          install.textContent = 'connect';
          return clear(output).append(el('div', 'small', el('span', 'tag err', 'failed'), ' ', result.error || 'MCP server failed to start'));
        }
        const status = (result.report || []).find((item) => item.name === preset.id);
        if (!status?.running) {
          clear(output).append(el('div', 'small', el('span', 'tag err', 'not running'), ' ', status?.error || 'Server was added but did not connect.'));
        } else {
          clear(output).append(el('div', 'small', el('span', 'tag ok', 'connected'), ` ${preset.label} · ${status.tools.length} tools`));
        }
        await refresh();
      };
      catalogBox.append(
        el('div', 'card tight',
          el('div', 'row', el('b', '', preset.label), el('span', 'grow'), install),
          el('div', 'small muted', preset.note || ''),
        ),
      );
    }
  }

  const customName = el('input');
  customName.placeholder = 'server name';
  const customCommand = el('input');
  customCommand.placeholder = 'command (e.g. npx)';
  const customArgs = el('textarea');
  customArgs.placeholder = 'one argument per line (e.g. -y then package-name)';
  customArgs.rows = 3;
  const customCwd = el('input');
  customCwd.placeholder = 'working directory (optional)';
  const addCustom = el('button', 'btn sm', 'add custom server');
  addCustom.onclick = async () => {
    const name = customName.value.trim();
    const command = customCommand.value.trim();
    const args = customArgs.value.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean);
    if (!name || !command) return toast('server name and command are required', 'err');
    if (!confirm('Custom MCP servers execute local programs. Add only a server whose source and permissions you trust. Continue?')) return;
    addCustom.disabled = true;
    const result = await api('/api/mcp', {
      action: 'add',
      server: { name, command, args, cwd: customCwd.value.trim() || undefined },
    });
    addCustom.disabled = false;
    if (!result.ok) return toast(result.error || 'could not add MCP server', 'err');
    customName.value = '';
    customCommand.value = '';
    customArgs.value = '';
    customCwd.value = '';
    toast('MCP server added');
    refresh();
  };

  body.append(
    el('div', 'card', el('b', '', 'MCP servers'), el('div', 'small muted', 'MCP servers are local programs, not trusted plugins by default. Review each server before connecting; calls still pass through Nexus policy and approval. Secrets should use the server’s OAuth flow or an OS-managed environment variable, never chat.')),
    el('div', 'row wrap', openBrowser, el('span', 'grow'), refreshButton),
    el('h3', '', 'Connected servers'),
    serversBox,
    output,
    el('h3', '', 'Official and curated servers'),
    catalogBox,
    el('details', '', el('summary', '', 'Add a custom stdio server'), el('div', 'small faint', 'Do not paste tokens or passwords here. First-run package downloads execute code on this PC.'),
      customName, customCommand, customArgs, customCwd, addCustom),
  );
  refresh();
}

/* -------------------------------- connect app ----------------------------- */
function renderConnect(body) {
  clear(body);
  const modelSetup = el('div', 'connections-model-setup');
  renderProviders(modelSetup);
  const statusBox = el('div');
  const readyBox = el('div');
  const cards = el('div');

  async function refresh() {
    const s = await api('/api/connect');
    clear(statusBox).append(
      el('span', 'tag ' + (s.kaggle.connected ? 'ok' : 'err'), 'kaggle'),
      el('span', 'tag ' + (s.google.connected ? 'ok' : 'err'), 'google'),
      el('span', 'tag ' + (s.github.connected ? 'ok' : 'err'), 'github'),
      el('span', 'tag ' + (s.discord.connected ? 'ok' : 'err'), 'discord'),
      el('span', 'tag ' + (s.telegram.connected ? 'ok' : 'err'), 'telegram'),
      el('span', 'tag ' + (s.providers.length ? 'ok' : 'warn'), `${s.providers.length} provider(s)`),
    );
    clear(readyBox);
    readyBox.append(el('div', 'small faint', 'What each automation needs:'));
    for (const r of s.readiness.ready) {
      readyBox.append(el('div', 'filerow', el('span', 'tag ' + (r.ok ? 'ok' : 'warn'), r.ok ? 'ready' : 'missing ' + r.needs.join('+')), el('span', 'grow small', r.automation), el('span', 'small faint', r.why)));
    }
    return s;
  }

  const card = (title, state, lines, controls) => {
    const c = el('div', 'card');
    c.append(el('div', 'row', el('b', '', title), el('span', 'grow'), el('span', 'tag ' + (state.ok ? 'ok' : ''), state.ok ? 'connected' : state.text || 'not connected')));
    for (const l of lines) c.append(el('div', 'small muted', l));
    const row = el('div', 'row wrap');
    for (const x of controls) row.append(x);
    c.append(row);
    return { c, row };
  };

  const openLink = (url, label) => {
    const b = el('button', 'btn sm ghost', label);
    b.onclick = () => window.open(url, '_blank');
    return b;
  };
  const field = (label, input, hint) => {
    const l = el('label', 'field', el('span', '', label), input);
    if (hint) l.append(el('div', 'small faint', hint));
    return l;
  };

  (async () => {
    const s = await refresh();
    const configured = state.settings || {};

    // Search providers
    const search = configured.search || {};
    const searchProvider = el('select');
    for (const [value, label] of [['ddg', 'DuckDuckGo (no key)'], ['searx', 'SearXNG instance'], ['brave', 'Brave API'], ['tavily', 'Tavily API']]) {
      const option = el('option', '', label);
      option.value = value;
      if ((search.provider || 'ddg') === value) option.selected = true;
      searchProvider.append(option);
    }
    const searxUrl = el('input');
    searxUrl.value = search.searxUrl || '';
    const braveKey = el('input');
    braveKey.type = 'password';
    braveKey.value = search.braveKey || '';
    const tavilyKey = el('input');
    tavilyKey.type = 'password';
    tavilyKey.value = search.tavilyKey || '';
    const saveSearch = el('button', 'btn sm primary', 'save search settings');
    saveSearch.onclick = async () => {
      const result = await api('/api/settings', {
        search: { provider: searchProvider.value, searxUrl: searxUrl.value, braveKey: braveKey.value, tavilyKey: tavilyKey.value },
      });
      if (!result.ok) return toast(result.error || 'could not save search settings', 'err');
      state.settings = result.settings;
      toast('search settings saved');
    };
    const searchCard = card('Web search', { ok: false, text: search.provider || 'DuckDuckGo' }, [
      'DuckDuckGo needs no key. Add credentials only for the selected paid or self-hosted search service.',
    ], []);
    searchCard.c.append(
      field('Search service', searchProvider),
      el('div', 'split', field('SearXNG URL', searxUrl), field('Brave API key', braveKey)),
      field('Tavily API key', tavilyKey),
      el('div', 'row', saveSearch),
    );
    cards.append(searchCard.c);

    // Kaggle — the one that can be fully automatic
    const kg = card('Kaggle', { ok: s.kaggle.connected, text: s.kaggle.detail || 'not connected' }, [
      'Detect kaggle.json from Downloads, or enter your Kaggle API credentials here.',
    ], []);
    const kaggleUsername = el('input');
    kaggleUsername.value = configured.kaggle?.username || '';
    const kaggleKey = el('input');
    kaggleKey.type = 'password';
    kaggleKey.value = configured.kaggle?.key || '';
    const saveKaggle = el('button', 'btn sm', 'save + test Kaggle');
    saveKaggle.onclick = async () => {
      const saved = await api('/api/settings', { kaggle: { username: kaggleUsername.value, key: kaggleKey.value } });
      if (!saved.ok) return toast(saved.error || 'could not save Kaggle settings', 'err');
      state.settings = saved.settings;
      const result = await api('/api/kaggle/test', {});
      if (!result.ok) return toast(result.error || 'Kaggle verification failed', 'err');
      toast('Kaggle connected');
      refresh();
    };
    const det = el('button', 'btn sm primary', 'detect kaggle.json');
    det.onclick = async () => {
      det.disabled = true;
      det.textContent = 'looking in Downloads…';
      const r = await api('/api/connect', { action: 'kaggle-detect' });
      det.disabled = false;
      det.textContent = 'detect kaggle.json';
      if (!r.ok) return kg.c.append(el('div', 'small', el('span', 'tag err', 'failed'), ' ' + (r.error || '')));
      kg.c.append(el('div', 'small', el('span', 'tag ok', 'saved'), ` ${r.username} · ${r.note}`));
      refresh();
    };
    kg.c.append(el('div', 'split', field('Username', kaggleUsername), field('API key', kaggleKey)));
    kg.row.append(saveKaggle, openLink('https://www.kaggle.com/settings/account', 'open Kaggle settings'), det);
    cards.append(kg.c);

    // Google
    const g = card('Google (Gmail, Calendar, Drive)', { ok: s.google.connected, text: s.google.detail }, [
      `Add a free OAuth client once. Redirect URI: http://127.0.0.1:${state.port}/oauth/callback`,
    ], []);
    const googleClientId = el('input');
    googleClientId.value = configured.google?.clientId || '';
    googleClientId.placeholder = 'xxx.apps.googleusercontent.com';
    const googleClientSecret = el('input');
    googleClientSecret.type = 'password';
    googleClientSecret.value = configured.google?.clientSecret || '';
    const saveGoogle = async () => {
      const saved = await api('/api/settings', { google: { clientId: googleClientId.value, clientSecret: googleClientSecret.value } });
      if (!saved.ok) {
        toast(saved.error || 'could not save Google credentials', 'err');
        return false;
      }
      state.settings = saved.settings;
      return true;
    };
    const gb = el('button', 'btn sm primary', s.google.connected ? 'add another account' : 'connect google');
    const rerender = () => {
      closeWin('connect');
      openApp('connect');
    };
    gb.onclick = async () => {
      if (!await saveGoogle()) return;
      const label = prompt('Label for this Google account (work / personal / university / …)', '') || '';
      const r = await api('/api/google/auth', { label });
      if (!r.ok) return toast(r.error || 'failed', 'err');
      window.open(r.url, '_blank', 'width=520,height=680');
      const iv = panelPoll(body, async () => {
        const st = await api('/api/state');
        if (st.googleConnected) {
          clearInterval(iv);
          toast('google account connected');
          rerender();
        }
      }, 2500);
      setTimeout(() => clearInterval(iv), 300000);
    };
    const accInfo = await api('/api/google/accounts').catch(() => ({ accounts: [] }));
    const accRow = el('div', 'row wrap');
    if (!(accInfo.accounts || []).length) accRow.append(el('span', 'small faint', 'no accounts yet'));
    for (const a of accInfo.accounts || []) {
      const b = el('button', 'btn sm' + (a.id === accInfo.activeId ? ' primary' : ''), `${a.label || a.email}${a.id === accInfo.activeId ? ' ✓' : ''}`);
      b.title = a.email || '';
      b.onclick = async () => {
        await api('/api/google/accounts', { action: 'switch', id: a.id });
        toast('active: ' + (a.label || a.email));
        rerender();
      };
      accRow.append(b);
    }
    const saveGoogleButton = el('button', 'btn sm', 'save OAuth credentials');
    saveGoogleButton.onclick = async () => {
      if (await saveGoogle()) toast('Google OAuth credentials saved');
    };
    g.c.append(
      el('div', 'split', field('OAuth client ID', googleClientId), field('OAuth client secret', googleClientSecret)),
      el('div', 'row wrap', saveGoogleButton),
      el('div', 'small faint', 'Accounts on this machine — one active at a time (Google allows one identity per session):'),
      accRow,
    );
    g.row.append(
      openLink('https://console.cloud.google.com/apis/credentials', 'open Cloud Console'),
      openLink('https://console.cloud.google.com/apis/library', 'enable APIs'),
      gb,
    );
    cards.append(g.c);

    // GitHub
    const gh = card('GitHub', { ok: s.github.connected, text: s.github.detail }, ['Fine-grained token with public repo read is enough.'], []);
    const ghIn = el('input');
    ghIn.type = 'password';
    ghIn.placeholder = 'ghp_… or github_pat_…';
    ghIn.style.flex = '1';
    const ghBtn = el('button', 'btn sm', 'save + verify');
    ghBtn.onclick = async () => {
      const r = await api('/api/connect', { action: 'github', token: ghIn.value });
      gh.c.append(el('div', 'small', el('span', 'tag ' + (r.ok ? 'ok' : 'err'), r.ok ? 'verified' : 'failed'), r.ok ? ` @${r.login}` : ' ' + r.error));
      if (r.ok) refresh();
    };
    gh.row.append(ghIn, ghBtn, openLink('https://github.com/settings/tokens', 'open tokens page'));
    cards.append(gh.c);

    // Discord
    const dc = card('Discord bot', { ok: s.discord.connected, text: s.discord.detail }, ['Developer Portal → Bot → Reset Token. Enable MESSAGE CONTENT INTENT or it cannot read messages.'], []);
    const dcIn = el('input');
    dcIn.type = 'password';
    dcIn.placeholder = 'bot token';
    dcIn.style.flex = '1';
    const dcBtn = el('button', 'btn sm', 'save + verify');
    dcBtn.onclick = async () => {
      const r = await api('/api/connect', { action: 'discord', token: dcIn.value });
      dc.c.append(el('div', 'small', el('span', 'tag ' + (r.ok ? 'ok' : 'err'), r.ok ? 'verified' : 'failed'), r.ok ? ` as ${r.username}` : ' ' + r.error));
      if (r.ok) refresh();
    };
    dc.row.append(dcIn, dcBtn, openLink('https://discord.com/developers/applications', 'open portal'));
    cards.append(dc.c);

    // Telegram — the other out-of-band channel
    const tg = card('Telegram (automation results)', { ok: s.telegram.connected, text: s.telegram.detail }, ['Talk to @BotFather → /newbot → paste the token. Then send any message to your bot and press “find my chat id”.'], []);
    const tgIn = el('input');
    tgIn.type = 'password';
    tgIn.placeholder = 'bot token';
    const tgChat = el('input');
    tgChat.placeholder = 'chat id (e.g. 123456789)';
    const tgBtn = el('button', 'btn sm', 'save + send test');
    tgBtn.onclick = async () => {
      const r = await api('/api/connect', { action: 'telegram', token: tgIn.value, chatId: tgChat.value });
      tg.c.append(el('div', 'small', el('span', 'tag ' + (r.ok ? 'ok' : 'err'), r.ok ? 'verified' : 'failed'), r.ok ? ` @${r.bot} · ${r.note}` : ' ' + r.error));
      if (r.ok) refresh();
    };
    tg.row.append(tgIn, tgChat, tgBtn);
    cards.append(tg.c);

    // Accounts discovered in the Codex data, with the email each one uses.
    const acc = await api('/api/accounts').catch(() => ({ items: [] }));
    const accBox = el('div');
    accBox.append(el('div', 'small faint', 'Starter service links. Handles and email addresses are blank until you add your own; these links are not account verification.'));
    for (const a of acc.items || []) {
      const row = el('div', 'filerow');
      const mon = el('button', 'btn sm ghost', 'monitor');
      mon.onclick = async () => {
        const r = await api('/api/watch', { action: 'add', url: a.watch, label: a.service + ' — listings', id: 'w_' + a.id });
        r.ok ? toast('monitoring ' + a.service) : toast(r.error || 'failed', 'err');
      };
      row.append(
        el('span', 'tag', a.service),
        el('span', 'grow small ellipsis', a.handle || (a.notes || '').slice(0, 46)),
        el('span', 'small mono', a.email || '—'),
        a.watch ? mon : el('span', 'small faint', 'no listings page'),
      );
      accBox.append(row);
    }
    const checkAll = el('button', 'btn sm', 'check all monitors');
    const watchOut = el('div');
    checkAll.onclick = async () => {
      checkAll.disabled = true;
      checkAll.textContent = 'checking…';
      const r = await api('/api/watch', { action: 'checkall' });
      checkAll.disabled = false;
      checkAll.textContent = 'check all monitors';
      clear(watchOut).append(el('div', 'small faint', `${r.checked} monitor(s) checked · ${r.changed} changed`));
      for (const x of (r.results || []).filter((y) => y.changed).slice(0, 8)) {
        watchOut.append(el('div', 'card tight', el('b', '', x.label || x.id), el('div', 'small muted', (x.appeared || []).slice(0, 12).join(' · '))));
      }
    };
    accBox.append(el('div', 'row', el('span', 'grow'), checkAll), watchOut);

    body.append(
      el('div', 'card', el('b', '', 'Connections'), el('div', 'small muted', 'One hub for local and cloud models, connection tests, search, Google, Kaggle, GitHub, Discord, and Telegram.')),
      modelSetup,
      statusBox,
      el('h3', '', 'Services and API connections'),
      cards,
      el('h3', '', 'Accounts and monitors'),
      accBox,
      el('h3', '', 'Automation readiness'),
      readyBox,
    );
  })();
}

/* ---------------------------------- work app ------------------------------ */
function renderWork(body) {
  clear(body);
  const head = el('div', 'row wrap');
  const sourcesBox = el('div');
  const autosBox = el('div');
  const skillsBox = el('div');
  const deriveBtn = el('button', 'btn sm primary', 'derive work skills');
  const refreshBtn = el('button', 'btn sm ghost', 'refresh');
  head.append(el('b', '', 'This PC · this work'), el('span', 'grow'), deriveBtn, refreshBtn);

  async function load() {
    const r = await api('/api/work');
    clear(sourcesBox);
    sourcesBox.append(
      el('div', 'row wrap',
        el('span', 'tag', `${r.automationCount} Codex automations`),
        el('span', 'tag', `${r.brainEntries} brain entries`),
        el('span', 'tag', `${r.sessions} sessions`),
        el('span', 'tag', `${r.accounts.length} accounts`),
        el('span', 'tag ' + (r.mirroredTasks.length ? 'ok' : ''), `${r.mirroredTasks.length} mirrored`),
      ),
      el('div', 'small faint mono', r.machine.home),
      el('div', 'row wrap small faint',
        el('span', '', `codex ${r.sources.codex.files} files`),
        el('span', '', `· claude ${r.sources.claude.files}`),
        el('span', '', `· documents ${r.sources.docs.files} (${r.sources.docs.mb} MB)`),
        el('span', '', `· workspace ${r.sources.workspace.files}`),
      ),
    );

    clear(autosBox);
    autosBox.append(el('div', 'small faint', 'Read-only inventory. Nothing here runs unless you mirror it into a Nexus task.'));
    for (const a of r.automations) {
      const row = el('div', 'filerow');
      const mirror = el('button', 'btn sm ghost', 'mirror');
      mirror.onclick = async () => {
        const m = await api('/api/work', { action: 'mirror', id: a.id, when: 'daily 07:00' });
        if (!m.ok) return toast(m.error || 'failed', 'err');
        toast(m.already ? 'already mirrored' : 'mirrored as a daily 07:00 task');
        load();
      };
      row.append(
        el('span', 'tag ' + (a.status === 'ACTIVE' ? 'ok' : ''), a.kind),
        el('span', 'grow ellipsis small', a.name),
        el('span', 'faint small mono', `${a.chars} chars`),
        mirror,
      );
      autosBox.append(row);
    }

    clear(skillsBox);
    if (!r.workSkills.length) skillsBox.append(el('div', 'small faint', 'No work skills yet — press “derive work skills”.'));
    for (const s of r.workSkills) {
      skillsBox.append(
        el('div', 'card tight',
          el('div', 'row', el('span', 'tag ok', 'work skill'), el('b', '', s.id), el('span', 'grow'), el('span', 'small faint', s.enabled ? 'enabled' : 'disabled')),
          el('div', 'small muted', s.description || ''),
        ),
      );
    }
  }

  deriveBtn.onclick = async () => {
    deriveBtn.disabled = true;
    deriveBtn.textContent = 'deriving…';
    const r = await api('/api/work', { action: 'derive', enable: true });
    deriveBtn.disabled = false;
    deriveBtn.textContent = 'derive work skills';
    if (!r.ok) return toast(r.error || 'failed', 'err');
    toast(`${r.written.length} work skill(s) written from your automations`);
    load();
  };
  refreshBtn.onclick = load;

  body.append(
    el('div', 'card',
      el('b', '', 'Kept separate on purpose'),
      el('div', 'small muted', 'Your Codex workflow is recorded, never executed automatically. Skills derived from your own work live under skills/work-* so they can be switched off without touching the general pack.'),
    ),
    head,
    sourcesBox,
    el('h3', '', 'Codex automations found on this PC'),
    autosBox,
    el('h3', '', 'Work skills derived from them'),
    skillsBox,
  );
  load();
}

/* --------------------------------- decks app ----------------------------- */
function renderDecks(body) {
  clear(body);
  body.append(
    el(
      'div',
      'card',
      el('b', '', 'Lecture deck'),
      el(
        'div',
        'small muted',
        'Drafts the outline in the SGVU teaching shape (concept → MCQ → answer), then renders it on your SGVU template with public-domain images. Two to four minutes.',
      ),
    ),
  );
  const topic = el('input');
  topic.placeholder = 'Topic — e.g. Isarithmic Mapping';
  const lecture = el('input');
  lecture.value = 'Lecture 6';
  lecture.style.flex = '0 0 140px';
  const go = el('button', 'btn primary', 'Build deck');
  const status = el('div', 'small muted', 'idle');
  const out = el('div', 'el-list');
  let busy = false;

  async function poll(id) {
    let r;
    try {
      r = await api('/api/decks', { action: 'status', id });
    } catch (e) {
      status.textContent = 'lost contact: ' + e.message;
      busy = false;
      go.disabled = false;
      return;
    }
    if (!r.ok) {
      status.textContent = r.error || 'job lost';
      busy = false;
      go.disabled = false;
      return;
    }
    const j = r.job;
    status.textContent = `${j.state} · ${j.seconds}s${j.slides ? ' · ' + j.slides + ' slides' : ''}`;
    if (j.state === 'done') {
      busy = false;
      go.disabled = false;
      const card = el('div', 'card');
      card.append(
        el('b', '', String(j.path || '').split(/[\\/]/).pop()),
        el('div', 'small muted', `${j.slides || '?'} slides · ${j.pictures || 0} images · outline from ${j.outlineSource}`),
      );
      const open = el('button', 'btn sm', 'Open in Viewer');
      open.onclick = () => openApp('viewer', j.path);
      card.append(el('div', 'row', open));
      out.prepend(card);
      return;
    }
    if (j.state === 'error') {
      busy = false;
      go.disabled = false;
      status.textContent = 'failed — ' + (j.error || 'unknown');
      return;
    }
    if (body.isConnected) setTimeout(() => { if (body.isConnected) poll(id).catch(e => { busy = false; go.disabled = false; status.textContent = e.message; }); }, 2500);
  }

  go.onclick = async () => {
    if (busy) return;
    if (!topic.value.trim()) {
      status.textContent = 'type a topic first';
      topic.focus();
      return;
    }
    busy = true;
    go.disabled = true;
    status.textContent = 'drafting outline…';
    try {
      const r = await api('/api/decks', { action: 'build', topic: topic.value, lecture: lecture.value });
      if (!r.ok) throw new Error(r.error || 'build refused');
      poll(r.job.id);
    } catch (e) {
      busy = false;
      go.disabled = false;
      status.textContent = 'error — ' + e.message;
    }
  };

  body.append(el('div', 'card', el('div', 'row', el('div', 'grow', topic), lecture), el('div', 'row', go, status, el('span', 'grow')), out));
}
registerApp({ id: 'decks', title: 'Decks', glyph: 'deck', size: [900, 660], render: renderDecks });

/* ---------------------------------- apps app ------------------------------ */
function renderApps(body) {
  clear(body);
  const head = el('div', 'row wrap');
  const grid = el('div', 'agent-grid');
  const progsBox = el('div');
  const diskBox = el('div');
  const q = el('input');
  q.placeholder = 'filter your installed apps…';
  const relaunch = el('button', 'btn sm ghost', 'rescan');
  head.append(q, relaunch);
  let allApps = [];

  function drawGrid() {
    const needle = q.value.trim().toLowerCase();
    clear(grid);
    const list = allApps.filter((a) => !needle || a.name.toLowerCase().includes(needle)).slice(0, 120);
    for (const a of list) {
      const card = el('div', 'mode-card');
      card.append(el('div', 'mode-head', el('b', 'ellipsis', a.name)));
      card.append(el('div', 'small faint ellipsis', a.target ? a.target.split(/[\\/]/).pop() : 'shortcut'));
      card.onclick = async () => {
        const r = await api('/api/apps', { action: 'launch', name: a.name });
        r.ok ? toast('launched ' + a.name) : toast(r.error || 'failed', 'err');
      };
      grid.append(card);
    }
    if (!list.length) grid.append(el('div', 'empty', 'nothing matches'));
  }

  async function loadApps(fresh) {
    clear(grid).append(el('div', 'empty', 'reading Start Menu…'));
    const r = await api('/api/apps' + (fresh ? '?fresh=1' : ''));
    allApps = r.apps || [];
    drawGrid();
  }

  async function loadPrograms() {
    clear(progsBox).append(el('div', 'empty', 'reading installed programs…'));
    const r = await api('/api/apps', { action: 'programs' });
    clear(progsBox);
    if (!r.ok) return progsBox.append(el('div', 'empty', r.error || 'failed'));
    clear(diskBox);
    for (const d of r.disks || []) {
      diskBox.append(el('div', 'row', el('span', 'tag ' + (d.freeGB < 10 ? 'err' : 'ok'), d.name + ':'), el('span', 'small', `${d.freeGB} GB free of ${d.totalGB} GB`)));
    }
    progsBox.append(el('div', 'small faint', `${r.programs.length} installed programs · largest first`));
    for (const p of r.programs.slice(0, 40)) {
      progsBox.append(
        el('div', 'filerow',
          el('span', 'grow ellipsis small', p.name),
          el('span', 'faint small mono', p.mb ? p.mb + ' MB' : '—'),
          el('span', 'faint small mono', p.version || ''),
        ),
      );
    }
    const open = el('button', 'btn sm', 'open Settings → Apps');
    open.onclick = async () => {
      const rr = await api('/api/apps', { action: 'open-uninstaller' });
      toast(rr.note || 'opened Windows Apps list');
    };
    progsBox.append(el('div', 'row', el('span', 'grow'), open), el('div', 'small faint', 'I will not uninstall anything silently — many Windows uninstallers are interactive or reboot, and a wrong registry string breaks an install.'));
  }

  relaunch.onclick = () => loadApps(true);
  q.addEventListener('input', drawGrid);

  body.append(
    el('div', 'card', el('b', '', 'Apps already on this PC'), el('div', 'small muted', 'Read from your Start Menu. Click to launch — they run as normal Windows apps, this is just a launcher inside the workspace.')),
    head,
    grid,
    el('h3', '', 'Disk pressure'),
    diskBox,
    el('h3', '', 'Installed programs'),
    progsBox,
  );
  loadApps(false);
  loadPrograms();
}

/* ---------------------------------- setup -------------------------------- */
registerApp({ id: 'chat', title: 'Nexus', glyph: '◈', size: [880, 640], render: renderChat });
registerApp({ id: 'search', title: 'Web Search', glyph: '⌕', size: [720, 560], render: renderSearch });
registerApp({ id: 'browser', title: 'Browser', glyph: '◐', size: [880, 660], render: renderBrowser });
registerApp({
  id: 'agents',
  title: 'Agent Cluster',
  glyph: '⬡',
  size: [900, 640],
  render: renderAgents,
  onArg: (win, arg) => {
    const ta = win.body.querySelector('textarea');
    if (ta && arg) ta.value = arg;
  },
});
registerApp({ id: 'tasks', title: 'Automations', glyph: '◷', size: [760, 620], render: renderTasks });
registerApp({ id: 'mail', title: 'Gmail', glyph: '✉', size: [760, 620], render: renderMail });
registerApp({ id: 'drive', title: 'Google Drive', glyph: '▤', size: [860, 680], render: renderDrive });
registerApp({ id: 'kaggle', title: 'Kaggle', glyph: 'K', size: [780, 600], render: renderKaggle });
registerApp({ id: 'skills', title: 'Skills', glyph: '✦', size: [760, 700], render: renderSkills });
registerApp({ id: 'terminal', title: 'Terminal', glyph: '▮', size: [760, 480], render: renderTerminal });
registerApp({ id: 'memory', title: 'Memory', glyph: '❖', size: [660, 520], render: renderMemory });
registerApp({ id: 'files', title: 'Files', glyph: '▤', size: [720, 540], render: renderFiles });
registerApp({ id: 'safety', title: 'Safety', glyph: '⛨', size: [780, 660], render: renderSafety });
registerApp({ id: 'vault', title: 'Vault', glyph: '⛁', size: [760, 680], render: renderVault });
registerApp({ id: 'community', title: 'Community', glyph: '◉', size: [780, 680], render: renderCommunity });
registerApp({ id: 'brain', title: 'Brain', glyph: '❋', size: [800, 700], render: renderBrain });
registerApp({ id: 'intel', title: 'Business', glyph: '◭', size: [820, 700], render: renderIntel });
registerApp({ id: 'lab', title: 'Lab', glyph: '▦', size: [860, 720], render: renderLab });
registerApp({
  id: 'radar',
  title: 'Global Intelligence',
  glyph: '◬',
  size: [1000, 780],
  render: renderGlobalIntel,
  onArg: (win, arg) => win.selectTab?.(arg?.tab || 'radar'),
});
registerApp({ id: 'appearance', title: 'Appearance', glyph: '◑', size: [640, 620], render: renderAppearance });
registerApp({ id: 'connect', title: 'Connections', glyph: '⊛', size: [900, 800], render: renderConnect });
registerApp({ id: 'mcp', title: 'MCP Servers', glyph: '⌘', size: [820, 740], render: renderMcp });
registerApp({ id: 'work', title: 'Work', glyph: '⌂', size: [860, 720], render: renderWork });
registerApp({ id: 'apps', title: 'Apps', glyph: '▩', size: [880, 720], render: renderApps });
registerApp({
  id: 'viewer',
  title: 'Viewer',
  glyph: '◱',
  size: [880, 740],
  render: renderViewer,
  onArg: (win, arg) => {
    win.argPath = arg;
    win.draw?.(arg);
  },
});
registerApp({ id: 'plugins', title: 'Plugins', glyph: '⌘', size: [720, 560], render: renderPlugins });
registerApp({ id: 'settings', title: 'Settings', glyph: '⚙', size: [720, 680], render: renderSettings });
registerApp({ id: 'doctor', title: 'Doctor', glyph: '✚', size: [660, 560], render: renderDoctor });
registerApp({ id: 'action-center', title: 'Action Center', glyph: '⚡', size: [420, 640], render: renderActionCenter });
registerApp({ id: 'workspaces', title: 'Workspaces', glyph: '▦', size: [720, 560], render: renderWorkspaces });
registerApp({ id: 'recipes', title: 'Recipes', glyph: '☰', size: [720, 600], render: renderRecipes });
registerApp({ id: 'missions', title: 'Missions', glyph: '⟳', size: [880, 720], render: renderMissions });


const DOCK = [
  ['chat', 'Nexus'],
  ['radar', 'Global Intel'],
  ['missions', 'Missions'],
  ['search', 'Search'],
  ['browser', 'Browser'],
  ['mail', 'Gmail'],
  ['drive', 'Drive'],
  ['connect', 'Connections'],
  ['lab', 'Geo / Python Lab'],
  ['mcp', 'MCP Servers'],
  ['settings', 'Settings'],
];

/* --------------------------- launcher (matrix) --------------------------- */
/* The dock stays one row so muscle memory survives; the launcher is the big-icon matrix: labelled
   tiles in a grid, searchable, one keystroke away (Ctrl+Space, or the first dock button). */
const launcherEl = $('#launcher');
let launcherFilter = '';

function launcherApps() {
  const order = DOCK.map(([id]) => id);
  const legacyHubAliases = new Set(['kaggle', 'intel']);
  const rest = [...apps.values()]
    .filter((a) => !order.includes(a.id) && !legacyHubAliases.has(a.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [...order.map((id) => apps.get(id)).filter(Boolean), ...rest];
}

function buildLauncherTiles() {
  const grid = $('#launcher-grid');
  if (!grid) return;
  clear(grid);
  const f = launcherFilter.trim().toLowerCase();
  let shown = 0;
  for (const def of launcherApps()) {
    if (f && !`${def.title} ${def.id}`.toLowerCase().includes(f)) continue;
    const tile = el('button', 'launcher-tile');
    const icon = el('span', 'licon');
    icon.innerHTML = svg(GLYPH_ICON[def.glyph] || (ICONS[def.glyph] ? def.glyph : 'chat'));
    tile.append(icon, el('span', 'lbl', def.title));
    tile.onclick = () => {
      closeLauncher();
      openApp(def.id);
    };
    grid.append(tile);
    shown += 1;
  }
  if (!shown) grid.append(el('div', 'faint small', 'no app matches that'));
}

function openLauncher() {
  if (!launcherEl) return;
  launcherEl.hidden = false;
  launcherFilter = '';
  const inp = $('#launcher-search');
  if (inp) {
    inp.value = '';
    inp.focus();
  }
  buildLauncherTiles();
}

function closeLauncher() {
  if (launcherEl) launcherEl.hidden = true;
}

if (launcherEl) {
  launcherEl.addEventListener('click', (e) => {
    if (e.target === launcherEl) closeLauncher();
  });
  const closeBtn = $('#launcher-close');
  if (closeBtn) closeBtn.onclick = closeLauncher;
  const search = $('#launcher-search');
  if (search)
    search.addEventListener('input', () => {
      launcherFilter = search.value;
      buildLauncherTiles();
    });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !launcherEl.hidden) closeLauncher();
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      openLauncher();
    }
  });
}

function buildDock() {
  const dock = $('#dock');
  clear(dock);
  // Launcher first: every app also exists as a big tile in the matrix.
  const launchBtn = el('button', 'dock-item dock-launch');
  launchBtn.title = 'All apps (Ctrl+Space)';
  launchBtn.innerHTML = svg('grid');
  launchBtn.append(el('span', 'dotind'), el('span', 'dock-tip', 'All apps'));
  launchBtn.onclick = () => openLauncher();
  dock.append(launchBtn);
  DOCK.forEach(([id, label], i) => {
    if (id === 'mcp') dock.append(el('div', 'dock-sep'));
    const def = apps.get(id);
    const b = el('button', 'dock-item');
    b.dataset.app = id;
    b.title = label;
    b.innerHTML = svg(GLYPH_ICON[def.glyph] || (ICONS[def.glyph] ? def.glyph : 'chat'));
    b.append(el('span', 'dotind'), el('span', 'dock-tip', label));
    b.onclick = () => {
      const w = wins.get(id);
      if (w && w.el.style.display !== 'none') {
        closeWin(id);
        return;
      }
      openApp(id);
    };
    dock.append(b);
  });
}

function refreshHeader() {
  const s = state.settings;
  const modelPill = $('#pill-model');
  modelPill.textContent = state.modelLabel || 'model';
  modelPill.title = 'Open Connections · selected provider: ' + (state.modelLabel || 'checking') + '. Each response identifies the provider that actually answered.';
  modelPill.onclick = () => openApp('connect');
  modelPill.classList.toggle('on', !state.models.error);
  modelPill.classList.toggle('warn', Boolean(state.models.error));
  const b = $('#pill-browser');
  const running = state.browser?.running;
  b.textContent = 'browser · ' + (running ? 'live' : 'off');
  b.classList.toggle('on', Boolean(running));
  const g = $('#pill-google');
  g.textContent = 'google · ' + (state.googleConnected ? (s?.google?.email ? s.google.email.split('@')[0] : 'on') : 'off');
  g.classList.toggle('on', Boolean(state.googleConnected));
}

async function loadState() {
  const st = await api('/api/state');
  if (!st.ok) throw new Error(st.error || 'Nexus state unavailable');
  Object.assign(state, st);
  wins.get('chat')?.refreshState?.();
  updateWorkspaceStatus(true);
  refreshHeader();
}

/* -------------------------------- palette -------------------------------- */
const palette = $('#palette');
let palSel = 0;
let palItems = [];

function openPalette() {
  palette.hidden = false;
  const inp = $('#palette-input');
  inp.value = '';
  inp.focus();
  renderPalette('');
}
function closePalette() {
  palette.hidden = true;
}
function renderPalette(q) {
  const list = $('#palette-list');
  clear(list);
  const query = q.trim().toLowerCase();
  palItems = [...apps.values()]
    .filter((a) => !query || a.title.toLowerCase().includes(query) || a.id.includes(query))
    .map((a) => ({ kind: 'app', id: a.id, title: a.title, sub: 'open app' }));
  if (query) palItems.push({ kind: 'ask', title: `Ask Nexus: “${q.trim()}”`, sub: 'run in chat', q: q.trim() });
  palSel = 0;
  palItems.forEach((it, i) => {
    const row = el('div', 'palette-item' + (i === 0 ? ' sel' : ''), el('span', '', it.kind === 'app' ? '◈' : '›'), el('span', '', it.title), el('span', 'k', it.kind === 'app' ? it.id : 'agent'));
    row.onclick = () => runPalette(i);
    list.append(row);
  });
}
function runPalette(i) {
  const it = palItems[i];
  if (!it) return;
  closePalette();
  if (it.kind === 'app') openApp(it.id);
  else {
    openApp('chat');
    setTimeout(() => wins.get('chat')?.sendToChat?.(it.q), 220);
  }
}

$('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
$('#palette-input').addEventListener('keydown', (e) => {
  const rows = $$('.palette-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    palSel = Math.min(palSel + 1, rows.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    palSel = Math.max(palSel - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(palSel);
    return;
  } else if (e.key === 'Escape') {
    closePalette();
    return;
  } else return;
  rows.forEach((r, i) => r.classList.toggle('sel', i === palSel));
  rows[palSel]?.scrollIntoView({ block: 'nearest' });
});
palette.addEventListener('click', (e) => {
  if (e.target === palette) closePalette();
});
$('#palette-btn').onclick = openPalette;

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette.hidden ? openPalette() : closePalette();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    openApp('chat');
  }
  if (e.key === 'Escape' && !palette.hidden) closePalette();
});


/* ========================= Phase 2: Action Center, Workspaces, Briefing ========================= */

function renderActionCenter(body) {
  const list = el('div', 'ac-list');
  const head = el('div', 'row', el('b', '', 'Proactive Intent Cards'), el('span', 'grow'), (() => {
    const b = el('button', 'btn sm ghost', 'Refresh');
    b.onclick = load;
    return b;
  })(), (() => {
    const b = el('button', 'btn sm ghost', 'Clear');
    b.onclick = async () => { await api('/api/action-center', { action: 'clear' }); load(); };
    return b;
  })());
  body.append(head, list);

  async function load() {
    list.innerHTML = '';
    const r = await api('/api/action-center').catch(() => ({ cards: [] }));
    const cards = r.cards || [];
    if (!cards.length) {
      list.append(el('div', 'card muted small', 'No proactive cards yet. Failed terminal commands, job errors, and briefing readiness will appear here.'));
      return;
    }
    for (const c of cards) {
      const card = el('div', 'card ac-card');
      card.append(
        el('div', 'row', el('b', '', c.title), el('span', 'grow'), el('span', 'tag ' + (c.severity === 'error' ? 'err' : ''), c.severity || 'info')),
        el('div', 'small muted', c.body || ''),
      );
      const actions = el('div', 'row');
      for (const a of c.actions || []) {
        const btn = el('button', 'btn sm', a.label || 'Act');
        btn.onclick = () => {
          openApp('chat');
          setTimeout(() => wins.get('chat')?.sendToChat?.(a.prompt), 250);
        };
        actions.append(btn);
      }
      card.append(actions);
      list.append(card);
    }
  }
  load();
}

function renderWorkspaces(body) {
  const list = el('div', 'ws-list');
  body.append(el('div', 'small muted', 'Spatial Thought Workspaces — switching hot-swaps the agent system overlay and preferred context.'), list);

  async function load() {
    list.innerHTML = '';
    const r = await api('/api/workspaces');
    for (const w of r.workspaces || []) {
      const active = w.id === r.activeId;
      const card = el('div', 'card' + (active ? ' ws-active' : ''));
      const sw = el('button', 'btn sm' + (active ? '' : ' primary'), active ? 'Active' : 'Switch');
      sw.disabled = active;
      sw.onclick = async () => {
        if (!(await activateWorkspaceContext(w.id))) return;
        toast('Workspace: ' + w.name);
        load();
      };
      card.append(
        el('div', 'row', el('span', 'ws-dot', { style: `background:${w.color || '#6ee7b7'}` }), el('b', '', w.name), el('span', 'grow'), sw),
        el('div', 'small muted', w.goal || ''),
        el('div', 'small faint', (w.pinnedApps || []).join(' · ')),
      );
      list.append(card);
    }
  }
  load();
}

function renderRecipes(body) {
  const list = el('div', '');
  body.append(el('div', 'small muted', 'Portable agent workflows. Run from here or via the recipe tool.'), list);
  async function load() {
    list.innerHTML = '';
    const r = await api('/api/recipes');
    for (const rec of r.recipes || []) {
      const card = el('div', 'card');
      const run = el('button', 'btn sm primary', 'Run');
      run.onclick = () => {
        openApp('chat');
        setTimeout(() => wins.get('chat')?.sendToChat?.(`Run the recipe "${rec.id}" now.`), 250);
      };
      card.append(
        el('div', 'row', el('b', '', rec.name), el('span', 'grow'), run),
        el('div', 'small muted', rec.description || ''),
        el('div', 'small faint', (rec.tags || []).join(', ') + (rec.schedule ? ' · ' + rec.schedule : '')),
      );
      list.append(card);
    }
  }
  load();
}

function renderMissions(body) {
  clear(body);
  const goal = el('textarea');
  goal.placeholder = 'Describe the outcome you want. Nexus will work through its connected tools and keep a resumable evidence trail.';
  goal.rows = 5;
  goal.style.width = '100%';
  const create = el('button', 'btn primary', 'Create mission');
  const kaggle = el('button', 'btn ghost', 'Kaggle research workflow');
  const business = el('button', 'btn ghost', 'Business opportunity review');
  const list = el('div', '');
  const detail = el('div', '');
  let selectedId = '';
  let polling = false;

  kaggle.onclick = () => {
    goal.value = [
      'Research and build a strong, rules-compliant Kaggle competition baseline.',
      'Competition URL or exact name: ',
      '',
      'Before coding, inspect the official competition page, metric, data, deadlines, and rules. Research relevant public papers, articles, GitHub repositories, and permitted prior work; cite sources and distinguish verified findings from assumptions. Never use leaked/private submissions or violate competition rules.',
      'Then inspect the data, establish a reproducible local baseline and validation split that matches the competition metric, check for leakage, and run experiments within available free compute limits. Record commands, settings, metrics, and artifact paths. Verify outputs and explain what remains uncertain. Do not claim a win or submit anything without my approval.',
    ].join('\n');
    goal.focus();
  };
  business.onclick = () => {
    goal.value = [
      'Evaluate a realistic business opportunity and give me an evidence-based path to validate it.',
      'Idea: ',
      'Market/location: ',
      'Starting budget: ',
      'Hours available per week: ',
      'My relevant skills/resources: ',
      'Risk constraints: ',
      '',
      'Research current customer demand, alternatives/competition, pricing, distribution, startup costs, and relevant laws using cited sources. Separate facts from estimates, show conservative unit economics and downside scenarios, then propose the cheapest measurable test before committing significant money. Do not promise income or returns.',
    ].join('\n');
    goal.focus();
  };

  async function loadDetail(id) {
    selectedId = id;
    const r = await api('/api/missions/' + encodeURIComponent(id));
    clear(detail);
    if (!r.ok) return detail.append(el('div', 'empty', r.error || 'Could not load mission'));
    const mission = r.mission;
    const header = el('div', 'row wrap',
      el('b', '', mission.goal),
      el('span', 'grow'),
      el('span', 'tag ' + (mission.status === 'completed' ? 'ok' : mission.status === 'running' ? 'warn' : mission.status === 'failed' || mission.status === 'needs_review' ? 'err' : ''), mission.status),
    );
    const controls = el('div', 'row wrap');
    if (['ready', 'paused', 'failed', 'needs_review'].includes(mission.status)) {
      const resume = el('button', 'btn sm primary', mission.status === 'ready' ? 'Run' : mission.status === 'needs_review' ? 'Review & resume' : 'Resume');
      resume.onclick = async () => {
        const acknowledgeRisk = mission.status === 'needs_review' || (mission.nodes || []).some((n) => n.kind === 'tool' && ['running', 'awaiting_checkpoint', 'indeterminate'].includes(n.status));
        if (acknowledgeRisk && !confirm('A tool action may have completed before Nexus stopped. Check its effects first; resuming could repeat it. Resume anyway?')) return;
        const out = await api('/api/missions', { action: 'start', id, acknowledgeRisk });
        if (!out.ok) return toast(out.error || 'Could not start mission', 'err');
        await refresh();
      };
      controls.append(resume);
    } else if (mission.status === 'running') {
      const pause = el('button', 'btn sm danger', 'Pause');
      pause.onclick = async () => {
        const out = await api('/api/missions', { action: 'pause', id });
        if (!out.ok) toast(out.error || 'Could not pause mission', 'err');
        await refresh();
      };
      controls.append(pause);
    } else if (mission.status === 'pausing') {
      controls.append(el('span', 'small faint', 'Pausing after the current action…'));
    }
    if (mission.error) controls.append(el('div', 'small muted', mission.error));
    detail.append(el('div', 'card', header, controls));

    if (['completed', 'failed'].includes(mission.status)) {
      const rating = el('select');
      for (let n = 1; n <= 5; n++) {
        const option = el('option', '', `${n}/5`);
        option.value = String(n);
        rating.append(option);
      }
      if (mission.feedback?.rating) rating.value = String(mission.feedback.rating);
      const note = el('textarea');
      note.placeholder = 'What should Nexus repeat or change next time? This feedback improves future prompts; it does not retrain the model.';
      note.value = mission.feedback?.note || '';
      note.rows = 2;
      note.style.width = '100%';
      const saveFeedback = el('button', 'btn sm', 'Save learning feedback');
      saveFeedback.onclick = async () => {
        const out = await api('/api/missions', { action: 'feedback', id, rating: Number(rating.value), note: note.value });
        if (!out.ok) return toast(out.error || 'Could not save feedback', 'err');
        toast('Feedback saved for future missions');
        await refresh();
      };
      detail.append(el('div', 'card', el('b', '', 'Help Nexus improve'), el('div', 'row', rating, saveFeedback), note));
    }

    const graph = el('div', '');
    for (const node of mission.nodes || []) {
      const item = el('div', 'card tight');
      const top = el('div', 'row wrap',
        el('span', 'tag ' + (['succeeded', 'complete', 'approved', 'saved', 'recorded'].includes(node.status) ? 'ok' : node.status === 'failed' || node.status === 'denied' || node.status === 'indeterminate' ? 'err' : node.status === 'running' || node.status === 'waiting' ? 'warn' : ''), node.status),
        el('b', '', node.title),
        el('span', 'grow'),
        el('span', 'small faint', new Date(node.at).toLocaleTimeString()),
      );
      item.append(top);
      if (node.detail) item.append(el('div', 'small muted', node.detail));
      if (node.evidence) item.append(el('pre', 'pre tight', node.evidence));
      if (node.artifacts?.length) {
        for (const artifact of node.artifacts) item.append(el('div', 'small faint mono', `${artifact.name} · ${artifact.path}`));
      }
      if (node.kind === 'approval' && node.status === 'waiting' && node.approvalId) {
        const allow = el('button', 'btn sm primary', 'Allow once');
        const deny = el('button', 'btn sm danger', 'Deny');
        const decide = async (decision) => {
          const out = await api('/api/approvals', { id: node.approvalId, decision, scope: 'once' });
          if (!out.ok) toast(out.error || 'Approval expired', 'err');
          await refresh();
        };
        allow.onclick = () => decide('allow');
        deny.onclick = () => decide('deny');
        item.append(el('div', 'row', allow, deny));
      }
      graph.append(item);
    }
    detail.append(el('h3', '', 'Mission graph · actions and evidence'), graph);
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const r = await api('/api/missions');
      clear(list);
      if (!r.ok) list.append(el('div', 'empty', r.error || 'Could not load missions'));
      else if (!r.missions?.length) list.append(el('div', 'empty', 'No missions yet'));
      else for (const mission of r.missions) {
        const row = el('button', 'jobrow' + (mission.id === selectedId ? ' on' : ''));
        row.style.width = '100%';
        row.append(el('div', 'row', el('span', 'tag', mission.status), el('span', 'small ellipsis grow', mission.goal), el('span', 'small faint', new Date(mission.updatedAt).toLocaleString())));
        row.onclick = () => loadDetail(mission.id);
        list.append(row);
      }
      if (selectedId) await loadDetail(selectedId);
    } finally {
      polling = false;
    }
  }

  create.onclick = async () => {
    if (!goal.value.trim()) return toast('Describe a mission first', 'err');
    create.disabled = true;
    try {
      const r = await api('/api/missions', { action: 'create', goal: goal.value });
      if (!r.ok) return toast(r.error || 'Could not create mission', 'err');
      goal.value = '';
      selectedId = r.mission.id;
      await refresh();
    } finally {
      create.disabled = false;
    }
  };

  body.append(
    el('div', 'card', el('b', '', 'Persistent, resumable agent missions'), el('div', 'small muted', 'Runs use Nexus tools and existing approvals. A restart saves the last checkpoint. Uncertain actions require review before resume.')),
    el('div', 'card', goal, el('div', 'row wrap', create, kaggle, business)),
    el('h3', '', 'Missions'),
    list,
    detail,
  );
  refresh();
  panelPoll(body, refresh, 1800);
}

async function setActiveChatWorkspace(id) {
  if (!id || id === activeWorkspaceId) return true;
  const win = wins.get('chat');
  if (win?.busy) {
    toast('Stop the current chat task before switching workspaces.', 'warn');
    return false;
  }
  await win?.persistChat?.();
  activeWorkspaceId = id;
  if (win) {
    win.chatWorkspaceId = id;
    renderChat(win.body, win);
  }
  return true;
}

async function activateWorkspaceContext(id) {
  if (wins.get('chat')?.busy) {
    toast('Stop the current chat task before switching workspaces.', 'warn');
    return false;
  }
  const r = await api('/api/workspaces', { action: 'activate', id });
  if (!r.ok) {
    toast(r.error || 'Could not switch workspace', 'err');
    return false;
  }
  if (!(await setActiveChatWorkspace(id))) return false;
  await refreshWorkspacePill();
  return true;
}

async function refreshWorkspacePill() {
  try {
    const r = await api('/api/workspaces');
    const w = (r.workspaces || []).find((x) => x.id === r.activeId);
    if (r.activeId && r.activeId !== activeWorkspaceId) await setActiveChatWorkspace(r.activeId);
    const workspaceSelect = $('#workspace-selector');
    if (workspaceSelect) {
      clear(workspaceSelect);
      for (const workspace of r.workspaces || []) {
        const option = el('option', '', workspace.name);
        option.value = workspace.id;
        workspaceSelect.append(option);
      }
      workspaceSelect.value = r.activeId || 'default';
    }
    let pill = document.getElementById('pill-workspace');
    if (!pill) {
      pill = el('button', 'pill', '');
      pill.id = 'pill-workspace';
      pill.title = 'Active workspace';
      pill.onclick = () => openApp('workspaces');
      document.querySelector('.menubar-center')?.append(pill);
    }
    pill.textContent = w ? `▦ ${w.name}` : '▦ workspace';
  } catch {}
}

async function refreshActionCenterBadge() {
  try {
    const r = await api('/api/action-center');
    const n = (r.cards || []).length;
    let pill = document.getElementById('pill-ac');
    if (!pill) {
      pill = el('button', 'pill', '⚡');
      pill.id = 'pill-ac';
      pill.title = 'Action Center';
      pill.onclick = () => openApp('action-center');
      document.querySelector('.menubar-center')?.append(pill);
    }
    pill.textContent = n ? `⚡ ${n}` : '⚡';
  } catch {}
}

async function renderWallpaperBriefing() {
  const wall = document.getElementById('wallpaper');
  if (!wall) return;
  let box = document.getElementById('briefing-widget');
  if (!box) {
    box = el('div', 'briefing-widget');
    box.id = 'briefing-widget';
    wall.append(box);
  }
  try {
    const r = await api('/api/briefing');
    if (!r.has || !r.briefing) {
      box.innerHTML = '<div class="bw-title">Morning Briefing</div><div class="bw-body muted">No briefing yet. Ask Nexus to run morning_briefing or the morning-brief recipe.</div>';
      return;
    }
    const lines = String(r.briefing).split('\n').slice(0, 18).join('\n');
    box.innerHTML = '';
    box.append(
      el('div', 'bw-title', 'Morning Briefing'),
      el('pre', 'bw-body', lines),
      (() => {
        const row = el('div', 'row');
        const refresh = el('button', 'btn sm ghost', 'Refresh');
        refresh.onclick = async () => {
          openApp('chat');
          setTimeout(() => wins.get('chat')?.sendToChat?.('Generate a fresh morning briefing now using the morning_briefing tool.'), 250);
        };
        const open = el('button', 'btn sm', 'Open full');
        open.onclick = () => {
          openApp('chat');
          setTimeout(() => wins.get('chat')?.sendToChat?.('Show the latest morning briefing in full.'), 250);
        };
        row.append(refresh, open);
        return row;
      })(),
    );
  } catch {
    box.innerHTML = '<div class="bw-title">Morning Briefing</div><div class="bw-body muted">Unable to load.</div>';
  }
}



function renderPlugins(body) {
  clear(body);
  const extensions = [
    {
      id: 'openai.chatgpt',
      name: 'OpenAI Codex',
      fit: 'Best for delegated coding tasks',
      detail: 'Official OpenAI coding agent for VS Code. Sign in inside VS Code with your ChatGPT account; plan eligibility and usage limits apply.',
      docs: 'https://developers.openai.com/codex/ide',
    },
    {
      id: 'GitHub.copilot',
      name: 'GitHub Copilot',
      fit: 'Best for editor completion + agent mode',
      detail: 'Official GitHub extension with inline coding and chat/agent workflows. Sign in with GitHub in VS Code; plan and quota limits apply.',
      docs: 'https://code.visualstudio.com/docs/copilot/overview',
    },
    {
      id: 'saoudrizwan.claude-dev',
      name: 'Cline',
      fit: 'Optional: configurable, permission-based agent',
      detail: 'Free extension; model/API usage may cost money. It can use local Ollama, and asks permission for its file and terminal actions.',
      docs: 'https://docs.cline.bot/getting-started/installing-cline',
    },
    {
      id: 'Continue.continue',
      name: 'Continue',
      fit: 'Optional: open-source coding assistant',
      detail: 'Open-source chat, edit, agent, and autocomplete workflows. Model hosting and usage costs depend on your configuration.',
      docs: 'https://docs.continue.dev',
    },
    {
      id: 'ms-python.python',
      name: 'Python',
      fit: 'Recommended for Kaggle and geospatial work',
      detail: 'Microsoft Python language support, debugging, test discovery, and environment management.',
      docs: 'https://code.visualstudio.com/docs/python/python-tutorial',
    },
    {
      id: 'ms-toolsai.jupyter',
      name: 'Jupyter',
      fit: 'Recommended for Kaggle notebooks',
      detail: 'Microsoft notebook editing and interactive computing. A Python/Jupyter kernel still needs to be installed in your environment.',
      docs: 'https://code.visualstudio.com/docs/datascience/jupyter-notebooks',
    },
    {
      id: 'GitHub.vscode-pull-request-github',
      name: 'GitHub Pull Requests',
      fit: 'Recommended for GitHub collaboration',
      detail: 'Official GitHub extension to browse and review issues and pull requests in VS Code; sign in there with GitHub.',
      docs: 'https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github',
    },
  ];
  const extensionGrid = el('div', 'extension-grid');
  for (const extension of extensions) {
    const id = extension.id;
    const marketplaceUrl = `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(id)}`;
    const openVsCode = el('a', 'btn sm primary', 'Open in VS Code');
    openVsCode.href = `vscode:extension/${id}`;
    openVsCode.target = '_blank';
    openVsCode.rel = 'noreferrer';
    const marketplace = el('a', 'btn sm ghost', 'Marketplace');
    marketplace.href = marketplaceUrl;
    marketplace.target = '_blank';
    marketplace.rel = 'noreferrer';
    const docs = el('a', 'small faint', 'Sign-in / setup');
    docs.href = extension.docs;
    docs.target = '_blank';
    docs.rel = 'noreferrer';
    extensionGrid.append(
      el('div', 'card tight extension-card',
        el('div', 'row wrap', el('b', '', extension.name), el('span', 'grow'), el('span', 'tag', extension.fit)),
        el('div', 'small muted', extension.detail),
        el('div', 'row wrap', openVsCode, marketplace, docs),
      ),
    );
  }
  const googleSkills = el('div', 'card',
    el('b', '', 'Google Workspace skills are already built in'),
    el('div', 'small muted', 'Connect Google once to use Nexus with Gmail, Drive, Docs, Sheets, and Calendar. The Skills app has one-click workflows for inbox triage, Drive/Docs research, document drafting, Sheets analysis, and PowerPoint generation. Nexus does not need your Google password.'),
  );
  const connectGoogle = el('button', 'btn sm primary', 'connect / manage Google');
  connectGoogle.onclick = () => openApp('connect');
  googleSkills.append(el('div', 'row', connectGoogle));
  body.append(
    el('div', 'card',
      el('b', '', 'Recommended VS Code agents and extensions'),
      el('div', 'small muted', 'These open the official Marketplace or hand off to VS Code for installation. Sign in inside the extension using its official account flow; Nexus never asks for those passwords or receives extension credentials. Marketplace agents run in VS Code, not inside Nexus.'),
    ),
    googleSkills,
    extensionGrid,
    el('div', 'card tight small muted', 'Privacy and cost: coding agents may send selected code/context to their provider and can have plan limits or API charges. Check each extension’s current terms and review its permissions. Cline and Continue are optional alternatives; installing several agents is not required.'),
    el('h3', '', 'Local Nexus plugins'),
    el('div', 'small muted', 'Pure ESM plugins under data/plugins/. See docs/PLUGIN-SDK.md. Tools still pass through the safety gate.'),
  );
  const list = el('div', 'plugin-list');
  body.append(list);
  const reloadBtn = el('button', 'btn sm', 'Reload plugins');
  reloadBtn.onclick = async () => {
    const r = await api('/api/plugins', { action: 'reload' });
    if (r.ok) { toast('plugins reloaded'); load(); }
    else toast(r.error || 'reload failed', 'err');
  };
  body.append(el('div', 'row', reloadBtn));

  async function load() {
    list.innerHTML = '';
    const r = await api('/api/plugins').catch(() => ({ plugins: [] }));
    const items = r.plugins || [];
    if (!items.length) {
      list.append(el('div', 'card muted small', 'No plugins found. Create data/plugins/hello/plugin.json + index.js (see PLUGIN-SDK).'));
      return;
    }
    for (const p of items) {
      const card = el('div', 'card');
      const status = p.loaded ? el('span', 'tag ok', 'loaded') : p.error ? el('span', 'tag err', 'error') : el('span', 'tag', 'off');
      card.append(
        el('div', 'row', el('b', '', p.name || p.id), el('span', 'grow'), status),
        el('div', 'small muted', p.description || ''),
        el('div', 'small faint', `${p.id} · v${p.version || '?'} · ${(p.permissions || []).join(', ') || 'no extra perms'}`),
      );
      if (p.error) card.append(el('div', 'small', el('span', 'tag err', 'error'), ' ' + p.error));
      list.append(card);
    }
  }
  load();
}


/* ---------------------------------- boot --------------------------------- */
function buildWorkbench() {
  const panel = $('#workbench');
  if (!panel) return;

  const head = el('div', 'workbench-head', el('span', 'workbench-title', 'Workbench'), el('span', 'grow'));
  const tabs = el('div', 'workbench-tabs');
  const stage = el('div', 'workbench-stage');
  const views = [
    { id: 'browser', label: 'Browser', render: renderBrowser },
    { id: 'terminal', label: 'Terminal', render: renderTerminal },
    { id: 'files', label: 'Files', render: renderFiles },
    { id: 'drive', label: 'Drive', render: renderDrive },
  ];
  let active = '';
  let activeView = views[0];
  const full = el('button', 'btn sm ghost', 'Open full');
  full.title = 'Open this tool in the main workspace';
  full.onclick = () => openApp(activeView.id);
  head.append(full);

  const select = (view) => {
    if (active === view.id) return;
    stage.dispatchEvent(new Event('nexus-dispose'));
    clear(stage);
    active = view.id;
    activeView = view;
    for (const button of $$('.workbench-tab', tabs)) {
      button.classList.toggle('primary', button.dataset.view === active);
      button.setAttribute('aria-selected', String(button.dataset.view === active));
    }
    view.render(stage);
  };

  for (const view of views) {
    const button = el('button', 'btn sm workbench-tab', view.label);
    button.dataset.view = view.id;
    button.setAttribute('role', 'tab');
    button.onclick = () => select(view);
    tabs.append(button);
  }
  tabs.setAttribute('role', 'tablist');
  panel.append(head, tabs, stage);
  select(views[0]);
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function boot() {
  buildDock();
  buildWorkspace();
  buildWorkbench();
  tickClock();
  setInterval(tickClock, 1000);
  try {
    applyUi({});
    openApp('chat');
    await loadState();
    applyUi(state.settings?.ui || {});
  } catch (e) {
    updateWorkspaceStatus(false);
    toast('Nexus is not responding. Keep the startup window open, then refresh this page.', 'err');
  }
  const themeBtn = el('button', 'pill', '◑ theme');
  themeBtn.title = 'theme, density, accent';
  themeBtn.onclick = () => openApp('appearance');
  $('.menubar-right')?.prepend(themeBtn);
  // 7.0 system tray
  const tray = document.getElementById('os-tray');
  if (tray) {
    document.getElementById('tray-ac')?.addEventListener('click', () => openApp('action-center'));
    document.getElementById('tray-ws')?.addEventListener('click', () => openApp('workspaces'));
    document.getElementById('tray-plugins')?.addEventListener('click', () => openApp('plugins'));
    document.getElementById('tray-settings')?.addEventListener('click', () => openApp('settings'));
  }

  $('#pill-model').onclick = () => openApp('settings');
  $('#pill-browser').onclick = () => openApp('browser');
  $('#pill-google').onclick = () => openApp('mail');
  openApp('chat');
  refreshWorkspacePill();
  refreshActionCenterBadge();
  if (document.body.dataset.layout === 'desktop') renderWallpaperBriefing();

  // live events from the scheduler / server
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('task_end', (e) => {
      const d = JSON.parse(e.data);
      toast(`${d.ok ? '✓' : '✕'} ${d.label}` + (d.answer ? ` — ${String(d.answer).slice(0, 90)}` : ''), d.ok ? '' : 'err');
    });
    es.addEventListener('google', () => loadState());
    es.addEventListener('intent', () => { refreshActionCenterBadge(); toast('New Action Center card'); });
    es.addEventListener('briefing', () => renderWallpaperBriefing());
    es.addEventListener('bus', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.severity === 'error') refreshActionCenterBadge();
      } catch {}
    });

  } catch {}
  let statePollRunning = false;
  setInterval(async () => {
    if (document.hidden || statePollRunning) return;
    statePollRunning = true;
    try {
      const st = await api('/api/state');
      state.browser = st.browser;
      state.googleConnected = st.googleConnected;
      state.modelLabel = st.modelLabel;
      state.models = st.models;
      updateWorkspaceStatus(true);
      refreshHeader();
    } catch { updateWorkspaceStatus(false); }
    finally { statePollRunning = false; }
  }, 30000);
}

/* Focused navigation over the original Nexus tool registry. */
let workspaceLayout = 'focus';
let activeWorkspaceApp = 'chat';
const primaryApps = ['chat', 'radar', 'missions', 'connect', 'mcp', 'plugins'];
const specialistApps = ['radar', 'missions'];
const workspaceLabels = {
  chat: 'Chat',
  radar: 'Global Intelligence',
  tasks: 'Automations',
  connect: 'Connections',
  mcp: 'MCP Servers',
  plugins: 'Plugins & Extensions',
  settings: 'Settings',
  decks: 'Presentations',
  drive: 'Google Drive',
};
function setWorkspaceLayout(mode) {
  workspaceLayout = mode === 'desktop' ? 'desktop' : 'focus';
  document.body.dataset.layout = workspaceLayout;
  try { localStorage.setItem('nexus.workspace.layout', workspaceLayout); } catch {}
  $('#workspace-layout').textContent = workspaceLayout === 'focus' ? 'Classic view' : 'Simple view';
  activateWorkspace(activeWorkspaceApp);
}
function activateWorkspace(id) {
  activeWorkspaceApp = id;
  for (const [key, w] of wins) w.el.dataset.inactive = String(workspaceLayout === 'focus' && key !== id);
  for (const b of $$('.workspace-nav-button')) {
    b.classList.toggle('selected', b.dataset.app === id);
    b.setAttribute('aria-current', b.dataset.app === id ? 'page' : 'false');
  }
  if ($('#workspace-title')) $('#workspace-title').textContent = workspaceLabels[id] || apps.get(id)?.title || 'Nexus';
}
function buildWorkspace() {
  const aside = el('aside', 'workspace-sidebar');
  aside.setAttribute('aria-label', 'Workspace navigation');
  const logo = el('div', 'workspace-brand', el('span', 'workspace-logo', '◈'), el('div', '', 'Nexus', el('small', '', 'Your desktop assistant')));
  const workspaceSelect = el('select', 'workspace-select');
  workspaceSelect.id = 'workspace-selector';
  workspaceSelect.setAttribute('aria-label', 'Active chat workspace');
  workspaceSelect.append(el('option', '', 'Loading workspaces…'));
  workspaceSelect.onchange = async () => {
    if (!(await activateWorkspaceContext(workspaceSelect.value))) workspaceSelect.value = activeWorkspaceId;
  };
  const fresh = el('button', 'btn workspace-new', '+ New chat');
  fresh.onclick = () => { openApp('chat'); wins.get('chat')?.newChat?.(); };
  const history = el('button', 'workspace-history', '◷  Chat history');
  history.onclick = () => { openApp('chat'); wins.get('chat')?.showHistory?.(); };
  const search = el('input', 'workspace-search');
  search.placeholder = 'Search tools'; search.setAttribute('aria-label', 'Search Nexus tools');
  const nav = el('nav', 'workspace-nav');
  const button = def => {
    const b = el('button', 'workspace-nav-button'); b.dataset.app = def.id;
    const icon = el('span', 'workspace-icon'); icon.innerHTML = svg(GLYPH_ICON[def.glyph] || (ICONS[def.glyph] ? def.glyph : 'chat'));
    b.append(icon, el('span', '', workspaceLabels[def.id] || def.title)); b.onclick = () => openApp(def.id); return b;
  };
  let expanded = false;
  const draw = () => {
    clear(nav);
    const filter = search.value.trim().toLowerCase();
    if (filter) {
      const found = [...apps.values()].filter(a => `${a.id} ${a.title} ${workspaceLabels[a.id] || ''}`.toLowerCase().includes(filter));
      for (const def of found) nav.append(button(def));
      if (!found.length) nav.append(el('p', 'small muted', 'No matching tools'));
    } else {
      nav.append(el('div', 'workspace-section', 'GENERAL'));
      if (apps.has('chat')) nav.append(button(apps.get('chat')));
      nav.append(el('div', 'workspace-section', 'GLOBAL INTELLIGENCE'));
      for (const id of specialistApps) if (apps.has(id)) nav.append(button(apps.get(id)));
      nav.append(el('div', 'workspace-section', 'INTEGRATIONS'));
      for (const id of ['connect', 'mcp', 'plugins']) if (apps.has(id)) nav.append(button(apps.get(id)));
      const more = el('button', 'workspace-more', expanded ? '− Fewer tools' : '+ More tools');
      more.setAttribute('aria-expanded', String(expanded));
      more.onclick = () => { expanded = !expanded; draw(); }; nav.append(more);
      if (expanded) {
        nav.append(el('div', 'workspace-section', 'TOOLS'));
        for (const def of apps.values()) if (!primaryApps.includes(def.id) && !['connect', 'providers', 'settings', 'kaggle', 'intel'].includes(def.id)) nav.append(button(def));
      }
    }
    activateWorkspace(activeWorkspaceApp);
  };
  search.oninput = draw;
  const bottom = el('div', 'workspace-bottom');
  if (apps.has('settings')) bottom.append(button(apps.get('settings')));
  const help = el('div', 'workspace-foot', 'Nexus 7.1 · Refined edition');
  aside.append(logo, workspaceSelect, fresh, history, search, nav, bottom, help); document.body.append(aside);
  const layout = el('button', 'pill', 'Classic view'); layout.id = 'workspace-layout';
  layout.onclick = () => setWorkspaceLayout(workspaceLayout === 'focus' ? 'desktop' : 'focus');
  $('.menubar-right').prepend(layout);
  const title = el('span', 'workspace-title', 'Chat'); title.id = 'workspace-title'; $('.brand').append(title);
  const status = el('span', 'workspace-status', 'Checking connection…'); status.id = 'workspace-status'; status.setAttribute('role','status'); $('.menubar-right').prepend(status);
  const mobile = el('button', 'pill workspace-mobile', 'All tools'); mobile.onclick = () => openLauncher(); $('.menubar-right').prepend(mobile);
  let saved = 'focus'; try { saved = localStorage.getItem('nexus.workspace.layout') || 'focus'; } catch {}
  draw(); setWorkspaceLayout(saved);
  refreshWorkspacePill();
}
function updateWorkspaceStatus(ok) {
  const node = $('#workspace-status');
  if (node) { node.textContent = ok ? 'Connected to Nexus' : 'Nexus connection lost'; node.dataset.ok = String(ok); }
}

boot();
