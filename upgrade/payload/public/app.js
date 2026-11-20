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
let chatHistory = [];
let activeSessionId = null;
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
  roleSel.setAttribute('aria-label', 'Assistant role');
  roleSel.onchange = () => (win.role = roleSel.value);
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
    const r = await api('/api/sessions');
    const panel = el('div', 'card');
    panel.append(el('div', 'small faint', `${(r.items || []).length} saved session(s) — click to resume`));
    for (const s of (r.items || []).slice(0, 25)) {
      const row = el('div', 'filerow');
      const open = el('button', 'btn sm', 'resume');
      open.onclick = async () => {
        if (win.busy) return toast('Stop the current task before resuming a chat.', 'warn');
        ++sessionRevision;
        const full = await api('/api/sessions/' + s.id);
        if (!full.ok) return toast(full.error || 'failed', 'err');
        sessionId = full.session.id; activeSessionId = sessionId;
        chatHistory = (full.session.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
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
    activeSessionId = null;
    win.sessionId = null;
    chatHistory = [];
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
    const r = await api('/api/handoff', { note, title: lastUser.replace(/\s+/g, ' ').slice(0, 60) });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    sessionId = r.session.id; activeSessionId = sessionId;
    ++sessionRevision;
    chatHistory = [];
    clear(log);
    greeting();
    toast('handoff written to project memory · clean session started');
  };

  const options = el('details', 'chat-options');
  options.append(el('summary', '', 'Options'), el('div', 'chat-options-menu', bCluster, bHandoff, bHistory, bClear));
  bar.append(seg, roleSel, modePill, el('span', 'grow'), options);

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
  ta.placeholder = 'Describe a task, ask a question, or attach files…';
  const send = el('button', 'send', '↑');
  const stop = el('button', 'send stop', '⏹');
  stop.title = 'stop this run (Esc)';
  stop.style.display = 'none';
  box.append(attach, ta, send, stop);
  const hint = el('div', 'chat-hint', el('span', '', '⏎ send'), el('span', '', 'Ctrl+K jump'), el('span', '', 'drop files to attach'), el('span', '', 'web · files · shell · browser · gmail · kaggle'));
  composer.append(chips, box, hint, fileInput);
  shell.append(bar, log, composer);
  body.append(shell);

  let attachments = [];
  let sessionId = activeSessionId;
  let sessionRevision = 0;
  win.newChat = () => bClear.click();
  win.showHistory = () => bHistory.click();

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
    if (!chatHistory.length) return;
    const revision = sessionRevision;
    try {
      const r = await api('/api/sessions', { action: 'save', id: sessionId || undefined, messages: chatHistory, role: roleSel.value });
      if (r.ok && r.id && revision === sessionRevision) { sessionId = r.id; activeSessionId = r.id; win.sessionId = r.id; }
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
    welcome.append(el('div', 'welcome-mark', '◈'), el('h1', '', 'What would you like to do?'), el('p', '', 'Create, research, code, and automate in one conversation.'));
    const grid = el('div', 'workspace-suggestions');
    for (const [icon, label, detail, prompt] of [
      ['deck', 'Make a presentation', 'Turn a topic into slides', 'Build a PowerPoint presentation about '],
      ['search', 'Research a topic', 'Find answers with sources', 'Research with sources: '],
      ['files', 'Analyse my files', 'Work with documents and data', 'Help me analyse these files: '],
      ['terminal', 'Build or fix code', 'Explain, create, and debug', 'Help me build or fix ']
    ]) {
      const b = el('button', 'welcome-task'); const symbol = el('span','welcome-task-icon'); symbol.innerHTML = svg(icon);
      b.append(symbol, el('strong','',label), el('span','',detail));
      b.onclick = () => { ta.value = prompt; ta.dispatchEvent(new Event('input')); ta.focus(); };
      grid.append(b);
    }
    welcome.append(grid, el('small', '', 'Choose a starting point, or describe your own task below.'));
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
      if (chatHistory.length) return;
      const list = await api('/api/sessions');
      const last = (list.items || [])[0];
      if (!last) return;
      const full = await api('/api/sessions/' + last.id);
      if (sessionRevision || chatHistory.length || !body.isConnected || !full.ok || !(full.session.messages || []).length) return;
      sessionId = full.session.id; activeSessionId = sessionId;
      chatHistory = full.session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
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
    b.onclick = connectGoogle;
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

async function connectGoogle() {
  const r = await api('/api/google/auth', {});
  if (!r.ok) return toast(r.error, 'err');
  window.open(r.url, '_blank', 'width=520,height=680');
  const iv = panelPoll(body, async () => {
    const st = await api('/api/state');
    if (st.googleConnected) {
      state.googleConnected = true;
      state.settings = st.settings;
      clearInterval(iv);
      toast('Google connected');
      refreshHeader();
    }
  }, 2500);
  setTimeout(() => clearInterval(iv), 300000);
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

  /* model */
  const provider = el('select');
  for (const [v, t] of [['ollama', 'Ollama (local)'], ['openai', 'OpenAI-compatible API']]) {
    const o = el('option', '', t);
    o.value = v;
    if (s.provider === v) o.selected = true;
    provider.append(o);
  }
  const modelSel = el('select');
  const fillModels = (models, current) => {
    clear(modelSel);
    const opts = [...new Set([current, ...(models || [])].filter(Boolean))];
    for (const m of opts) {
      const o = el('option', '', m);
      o.value = m;
      if (m === current) o.selected = true;
      modelSel.append(o);
    }
    if (!opts.length) modelSel.append(el('option', '', 'no models — pull one first'));
  };
  fillModels(state.models.models, s.provider === 'openai' ? s.openai.model : s.model);

  const modelCustom = el('input');
  modelCustom.placeholder = 'or type a name — e.g. gemma4:31b-cloud (cloud, any PC)';
  modelCustom.value = '';

  const baseUrl = el('input');
  baseUrl.value = s.openai.baseUrl;
  const apiKey = el('input');
  apiKey.type = 'password';
  apiKey.value = s.openai.apiKey;
  apiKey.placeholder = 'sk-…';
  const ollamaUrl = el('input');
  ollamaUrl.value = s.ollamaUrl;
  const temp = el('input');
  temp.type = 'number';
  temp.step = '0.1';
  temp.min = '0';
  temp.max = '2';
  temp.value = s.temperature;
  const steps = el('input');
  steps.type = 'number';
  steps.value = s.maxSteps;

  const bRefresh = el('button', 'btn sm', 'refresh model list');
  bRefresh.onclick = async () => {
    const r = await api('/api/models');
    state.models = r;
    fillModels(r.models, modelSel.value);
    toast(r.error || `${r.models.length} models`);
  };

  const modelBlock = el(
    'div',
    '',
    el('h3', '', 'Model'),
    field('Provider', provider),
    field('Model', modelSel),
    field('Or type a model name', modelCustom, 'Cloud models run on Ollama’s servers: gemma4:31b-cloud, gpt-oss:20b-cloud, gpt-oss:120b-cloud.'),
    el('div', 'row', bRefresh),
    field('Ollama URL', ollamaUrl),
    field('API base URL', baseUrl, 'Any OpenAI-compatible endpoint: OpenAI, Groq, DeepSeek, OpenRouter, LM Studio, vLLM.'),
    field('API key', apiKey),
    el('div', 'split', field('Temperature', temp), field('Max agent steps', steps)),
  );

  /* search */
  const sp = el('select');
  for (const [v, t] of [['ddg', 'DuckDuckGo (no key)'], ['searx', 'SearXNG instance'], ['brave', 'Brave API'], ['tavily', 'Tavily API']]) {
    const o = el('option', '', t);
    o.value = v;
    if (s.search.provider === v) o.selected = true;
    sp.append(o);
  }
  const searxUrl = el('input');
  searxUrl.value = s.search.searxUrl;
  const braveKey = el('input');
  braveKey.value = s.search.braveKey;
  braveKey.type = 'password';
  const tavilyKey = el('input');
  tavilyKey.value = s.search.tavilyKey;
  tavilyKey.type = 'password';

  /* google */
  const gid = el('input');
  gid.value = s.google.clientId;
  gid.placeholder = 'xxx.apps.googleusercontent.com';
  const gsec = el('input');
  gsec.value = s.google.clientSecret;
  gsec.type = 'password';
  const gRow = el('div', 'row wrap');
  const bG = el('button', 'btn sm ' + (state.googleConnected ? '' : 'primary'), state.googleConnected ? `connected · ${s.google.email || ''}` : 'connect google');
  bG.onclick = () => (state.googleConnected ? api('/api/google/disconnect').then(() => location.reload()) : connectGoogle());
  gRow.append(bG);

  /* kaggle */
  const ku = el('input');
  ku.value = s.kaggle.username;
  const kk = el('input');
  kk.value = s.kaggle.key;
  kk.type = 'password';
  const bK = el('button', 'btn sm', 'test + write kaggle.json');
  bK.onclick = async () => {
    await save({ kaggle: { username: ku.value, key: kk.value } });
    const r = await api('/api/kaggle/test', {});
    r.ok ? toast('Kaggle OK') : toast(r.error || 'failed', 'err');
  };

  /* shell + browser */
  const shellOn = el('div', 'switch' + (s.shell.enabled ? ' on' : ''));
  shellOn.onclick = () => shellOn.classList.toggle('on');
  const port = el('input');
  port.type = 'number';
  port.value = s.browser.port;
  const persona = el('input');
  persona.value = s.agent.user || '';
  persona.placeholder = 'what should Nexus call you';

  const saveAll = el('button', 'btn primary', 'Save everything');
  saveAll.onclick = () =>
    save({
      provider: provider.value,
      model: modelCustom.value.trim() || modelSel.value,
      ollamaUrl: ollamaUrl.value,
      temperature: Number(temp.value),
      maxSteps: Number(steps.value),
      openai: { baseUrl: baseUrl.value, apiKey: apiKey.value, model: provider.value === 'openai' ? modelCustom.value.trim() || modelSel.value : s.openai.model },
      search: { provider: sp.value, searxUrl: searxUrl.value, braveKey: braveKey.value, tavilyKey: tavilyKey.value },
      google: { clientId: gid.value, clientSecret: gsec.value },
      kaggle: { username: ku.value, key: kk.value },
      shell: { enabled: shellOn.classList.contains('on') },
      browser: { port: Number(port.value) },
      agent: { user: persona.value },
    });

  body.append(
    modelBlock,
    el('h3', '', 'Web search'),
    field('Provider', sp),
    el('div', 'split', field('SearXNG URL', searxUrl), field('Brave key', braveKey)),
    field('Tavily key', tavilyKey),
    el('h3', '', 'Google Workspace'),
    field('OAuth client ID', gid, 'Cloud Console → Credentials → OAuth client. Redirect URI: ' + `http://127.0.0.1:${state.port}/oauth/callback`),
    field('OAuth client secret', gsec),
    gRow,
    el('h3', '', 'Kaggle'),
    el('div', 'split', field('Username', ku), field('API key', kk)),
    el('div', 'row', bK),
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

  const bLaunch = el('button', 'btn sm primary', 'launch chrome');
  const bQuit = el('button', 'btn sm ghost', 'quit');
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
  const bEnter = el('button', 'btn sm', '⏎');
  const bDown = el('button', 'btn sm', '↓');
  ctrl.append(idx, txt, bClick, bType, bEnter, bDown);

  bLaunch.onclick = async () => {
    toast('launching Chrome with the Nexus profile…');
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
  bEnter.onclick = async () => {
    await api('/api/browser', { action: 'press', key: 'Enter' });
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
    el('div', 'small faint', 'Click an element to select its number, then type. The agent drives this same tab.'),
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
function renderRadar(body) {
  clear(body);
  const head = el('div', 'row wrap');
  const out = el('div');
  const dig = el('div');
  const scanBtn = el('button', 'btn primary', 'scan now');
  const sched = el('button', 'btn sm', 'schedule daily 07:00');
  head.append(scanBtn, sched, el('span', 'grow'));

  body.append(
    el('div', 'card',
      el('b', '', 'Opportunity radar — India + world'),
      el('div', 'small muted', 'Competitions, grants, bounties and remote work. Each sweep writes new findings into your brain, scored against what it knows about you.'),
    ),
    el('div', 'row wrap', el('span', 'small faint', 'sources:'), ...['Unstop', 'Devfolio', 'HackerEarth', 'Startup India', 'Kaggle', 'MLH', 'GSoC', 'Bounties', 'Grants', 'Remote'].map((s) => el('span', 'tag', s))),
    head,
    dig,
    out,
  );

  async function loadSaved() {
    const r = await api('/api/radar');
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
    scanBtn.textContent = 'scanning 10 sources…';
    const r = await api('/api/radar', {});
    scanBtn.disabled = false;
    scanBtn.textContent = 'scan now';
    if (!r.ok) return toast(r.error || 'scan failed', 'err');
    clear(dig).append(el('div', 'pre', r.digest || ''));
    toast(`${r.items.length} found · ${r.saved} new`);
    loadSaved();
  };

  sched.onclick = async () => {
    const r = await api('/api/tasks', {
      when: 'daily 07:00',
      label: 'Morning opportunity radar',
      prompt: 'Run the opportunity radar (intel), then give me the top 5 items with deadlines in the next 30 days, India first. Be specific: title, deadline, prize, and the one action to take today.',
    });
    r.ok ? toast('scheduled for 07:00 daily') : toast(r.error || 'failed', 'err');
  };

  loadSaved();
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
  const installBox = el('div');
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

  body.append(
    head,
    listBox,
    el('h3', '', 'Install from the web'),
    el('div', 'small faint', 'Paste a link to a SKILL.md. It is scanned for instruction-override and credential patterns, and installed DISABLED so you can read it first.'),
    el('div', 'row', urlIn, previewBtn),
    previewOut,
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

  const f = { presetId: { value: '' } };
  const mk = (k, ph, type = 'text') => {
    const i = el('input');
    i.placeholder = ph;
    i.type = type;
    f[k] = i;
    return i;
  };

  async function refresh() {
    const r = await api('/api/providers');
    clear(listBox);
    for (const p of r.profiles || []) {
      const card = el('div', 'card tight');
      const test = el('button', 'btn sm ghost', 'test');
      test.onclick = async () => {
        test.disabled = true;
        test.textContent = '…';
        const t = await api('/api/providers', { action: 'test', id: p.id });
        test.disabled = false;
        test.textContent = 'test';
        toast(t.ok ? `ok · ${t.ms}ms` : `failed: ${t.error}`, t.ok ? '' : 'err');
        if (t.ok && t.note) card.append(el('div', 'small faint', t.note));
      };
      const act = el('button', 'btn sm ' + (p.active ? '' : 'primary'), p.active ? 'active' : 'use this');
      act.onclick = async () => {
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
      card.append(
        el('div', 'row', el('span', 'tag ' + (p.active ? 'ok' : ''), p.active ? 'active' : 'standby'), el('b', '', p.label), el('span', 'small faint ellipsis', p.model), el('span', 'grow'), test, act, del),
        el('div', 'small faint mono', p.baseUrl + (p.hasKey ? '  · key saved' : '')),
      );
      listBox.append(card);
    }
    if (!(r.profiles || []).length) listBox.append(el('div', 'empty', 'no providers yet — Settings → Model still works until you add one'));

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
        f.apiKey.focus();
      };
      presetRow.append(b);
    }
  }

  const kindSel = el('select');
  kindSel.style.width = 'auto';
  for (const k of ['openai', 'ollama']) kindSel.append(el('option', '', k));

  const add = el('button', 'btn primary', 'save provider');
  add.onclick = async () => {
    if (!f.baseUrl.value.trim() || !f.model.value.trim()) return toast('base URL and model are required', 'err');
    const r = await api('/api/providers', {
      action: 'add',
      profile: { label: f.label.value || 'provider', baseUrl: f.baseUrl.value, model: f.model.value, apiKey: f.apiKey.value, kind: kindSel.value, presetId: f.presetId.value },
    });
    if (!r.ok) return toast(r.error || 'failed', 'err');
    toast('provider saved');
    f.apiKey.value = '';
    refresh();
    loadState();
  };

  const disco = el('button', 'btn sm', 'find free models (OpenRouter)');
  disco.onclick = async () => {
    clear(discoBox).append(el('div', 'empty', 'asking OpenRouter for its catalogue…'));
    const r = await api('/api/providers', { action: 'discover' });
    clear(discoBox);
    if (!r.ok) return discoBox.append(el('div', 'empty', r.error || 'failed'));
    discoBox.append(el('div', 'small faint', `${r.free} free of ${r.total} models · sorted by context length`));
    for (const m of (r.models || []).slice(0, 40)) {
      const row = el('div', 'filerow');
      const use = el('button', 'btn sm ghost', 'use');
      use.onclick = () => {
        f.label.value = 'OpenRouter';
        f.baseUrl.value = 'https://openrouter.ai/api/v1';
        f.model.value = m.id;
        kindSel.value = 'openai';
        f.presetId.value = 'openrouter';
        toast('filled — paste your OpenRouter key, then save');
        f.apiKey.focus();
      };
      row.append(el('span', 'grow ellipsis', m.name || m.id), el('span', 'faint small mono', `${Math.round((m.context || 0) / 1000)}k`), use);
      discoBox.append(row);
    }
  };

  body.append(
    el('div', 'card', el('b', '', 'Providers — tried in order'), el('div', 'small muted', 'The active provider answers first. If it fails or rate-limits, the next one takes over and you see one line saying so.')),
    listBox,
    el('h3', '', 'Add from a preset'),
    presetRow,
    el('div', 'split', mk('label', 'label (Groq, OpenRouter…)'), mk('model', 'model id')),
    el('div', 'split', mk('baseUrl', 'base URL e.g. https://api.groq.com/openai/v1'), mk('apiKey', 'API key (blank for Ollama / LM Studio)', 'password')),
    el('div', 'row', kindSel, el('span', 'grow'), add),
    el('h3', '', 'Free models'),
    el('div', 'row', disco),
    discoBox,
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

/* -------------------------------- connect app ----------------------------- */
function renderConnect(body) {
  clear(body);
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

  (async () => {
    const s = await refresh();

    // Kaggle — the one that can be fully automatic
    const kg = card('Kaggle', { ok: s.kaggle.connected, text: s.kaggle.detail || 'not connected' }, [
      'No copy-paste needed: Kaggle downloads kaggle.json for you, and this picks it up from Downloads.',
    ], []);
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
    kg.row.append(openLink('https://www.kaggle.com/settings/account', 'open Kaggle settings'), det);
    cards.append(kg.c);

    // Google
    const g = card('Google (Gmail, Calendar, Drive)', { ok: s.google.connected, text: s.google.detail }, [
      'Needs a free OAuth client — about 4 minutes, once. The redirect URI must be exactly http://127.0.0.1:8787/oauth/callback',
    ], []);
    const gb = el('button', 'btn sm primary', s.google.connected ? 'add another account' : 'connect google');
    const rerender = () => {
      closeWin('connect');
      openApp('connect');
    };
    gb.onclick = async () => {
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
    g.c.append(el('div', 'small faint', 'Accounts on this machine — one active at a time (Google allows one identity per session):'), accRow);
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

    // Providers shortcut
    const pv = card('Model providers (Groq, OpenRouter, Ollama…)', { ok: (s.providers || []).length > 0, text: `${(s.providers || []).length} configured` }, ['Free tiers live here. Add several so one rate-limit does not stop the agent.'], []);
    const pvBtn = el('button', 'btn sm primary', 'open providers');
    pvBtn.onclick = () => openApp('providers');
    pv.row.append(pvBtn);
    cards.append(pv.c);

    // Accounts discovered in the Codex data, with the email each one uses.
    const acc = await api('/api/accounts').catch(() => ({ items: [] }));
    const accBox = el('div');
    accBox.append(el('div', 'small faint', 'These came from your own Codex automations. The email column is what the automation text says — it is not verified against the sites.'));
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
      el('div', 'card', el('b', '', 'Connect'), el('div', 'small muted', 'Each card verifies with a real API call before it says connected. I cannot sign in as you or pass a CAPTCHA — everything else is automated.')),
      statusBox,
      el('h3', '', 'Accounts and monitors'),
      accBox,
      cards,
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
registerApp({ id: 'kaggle', title: 'Kaggle', glyph: 'K', size: [780, 600], render: renderKaggle });
registerApp({ id: 'skills', title: 'Skills', glyph: '✦', size: [760, 700], render: renderSkills });
registerApp({ id: 'terminal', title: 'Terminal', glyph: '▮', size: [760, 480], render: renderTerminal });
registerApp({ id: 'memory', title: 'Memory', glyph: '❖', size: [660, 520], render: renderMemory });
registerApp({ id: 'files', title: 'Files', glyph: '▤', size: [720, 540], render: renderFiles });
registerApp({ id: 'safety', title: 'Safety', glyph: '⛨', size: [780, 660], render: renderSafety });
registerApp({ id: 'vault', title: 'Vault', glyph: '⛁', size: [760, 680], render: renderVault });
registerApp({ id: 'community', title: 'Community', glyph: '◉', size: [780, 680], render: renderCommunity });
registerApp({ id: 'brain', title: 'Brain', glyph: '❋', size: [800, 700], render: renderBrain });
registerApp({ id: 'intel', title: 'Intel', glyph: '◭', size: [820, 700], render: renderIntel });
registerApp({ id: 'lab', title: 'Lab', glyph: '▦', size: [860, 720], render: renderLab });
registerApp({ id: 'radar', title: 'Radar', glyph: '◬', size: [860, 720], render: renderRadar });
registerApp({ id: 'providers', title: 'Providers', glyph: '⇄', size: [820, 720], render: renderProviders });
registerApp({ id: 'appearance', title: 'Appearance', glyph: '◑', size: [640, 620], render: renderAppearance });
registerApp({ id: 'connect', title: 'Connect', glyph: '⊛', size: [820, 740], render: renderConnect });
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


const DOCK = [
  ['chat', 'Nexus'],
  ['search', 'Search'],
  ['browser', 'Browser'],
  ['agents', 'Clusters'],
  ['tasks', 'Automations'],
  ['mail', 'Gmail'],
  ['kaggle', 'Kaggle'],
  ['skills', 'Skills'],
  ['terminal', 'Terminal'],
  ['lab', 'Lab'],
  ['memory', 'Memory'],
  ['files', 'Files'],
  ['safety', 'Safety'],
  ['vault', 'Vault'],
  ['community', 'Community'],
  ['brain', 'Brain'],
  ['intel', 'Intel'],
  ['radar', 'Radar'],
  ['viewer', 'Viewer'],
  ['decks', 'Decks'],
  ['providers', 'Providers'],
  ['appearance', 'Appearance'],
  ['connect', 'Connect'],
  ['work', 'Work'],
  ['apps', 'Apps'],
  ['doctor', 'Doctor'],
  ['settings', 'Settings'],
];

/* --------------------------- launcher (matrix) --------------------------- */
/* The dock stays one row so muscle memory survives; the launcher is the big-icon matrix: labelled
   tiles in a grid, searchable, one keystroke away (Ctrl+Space, or the first dock button). */
const launcherEl = $('#launcher');
let launcherFilter = '';

function launcherApps() {
  const order = DOCK.map(([id]) => id);
  const rest = [...apps.values()]
    .filter((a) => !order.includes(a.id))
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
    if (i === 10) dock.append(el('div', 'dock-sep'));
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
  modelPill.title = 'Selected provider: ' + (state.modelLabel || 'checking') + '. Each response identifies the provider that actually answered.';
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
        await api('/api/workspaces', { action: 'activate', id: w.id });
        toast('Workspace: ' + w.name);
        refreshWorkspacePill();
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

async function refreshWorkspacePill() {
  try {
    const r = await api('/api/workspaces');
    const w = (r.workspaces || []).find((x) => x.id === r.activeId);
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
  body.append(
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
function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function boot() {
  buildDock();
  buildWorkspace();
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
const primaryApps = ['chat', 'files', 'browser', 'terminal', 'tasks', 'memory'];
const workspaceLabels = { chat: 'Chat', tasks: 'Automations', connect: 'Connections', decks: 'Presentations' };
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
      nav.append(el('div', 'workspace-section', 'WORKSPACE'));
      for (const id of primaryApps) if (apps.has(id)) nav.append(button(apps.get(id)));
      const more = el('button', 'workspace-more', expanded ? '− Fewer tools' : '+ More tools');
      more.setAttribute('aria-expanded', String(expanded));
      more.onclick = () => { expanded = !expanded; draw(); }; nav.append(more);
      if (expanded) for (const def of apps.values()) if (!primaryApps.includes(def.id) && !['connect','settings'].includes(def.id)) nav.append(button(def));
    }
    activateWorkspace(activeWorkspaceApp);
  };
  search.oninput = draw;
  const bottom = el('div', 'workspace-bottom');
  for (const id of ['connect','settings']) if (apps.has(id)) bottom.append(button(apps.get(id)));
  const help = el('div', 'workspace-foot', 'Nexus 7.1 · Refined edition');
  aside.append(logo, fresh, history, search, nav, bottom, help); document.body.append(aside);
  const layout = el('button', 'pill', 'Classic view'); layout.id = 'workspace-layout';
  layout.onclick = () => setWorkspaceLayout(workspaceLayout === 'focus' ? 'desktop' : 'focus');
  $('.menubar-right').prepend(layout);
  const title = el('span', 'workspace-title', 'Chat'); title.id = 'workspace-title'; $('.brand').append(title);
  const status = el('span', 'workspace-status', 'Checking connection…'); status.id = 'workspace-status'; status.setAttribute('role','status'); $('.menubar-right').prepend(status);
  const mobile = el('button', 'pill workspace-mobile', 'All tools'); mobile.onclick = () => openLauncher(); $('.menubar-right').prepend(mobile);
  let saved = 'focus'; try { saved = localStorage.getItem('nexus.workspace.layout') || 'focus'; } catch {}
  draw(); setWorkspaceLayout(saved);
}
function updateWorkspaceStatus(ok) {
  const node = $('#workspace-status');
  if (node) { node.textContent = ok ? 'Connected to Nexus' : 'Nexus connection lost'; node.dataset.ok = String(ok); }
}

boot();
