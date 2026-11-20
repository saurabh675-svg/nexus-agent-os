import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings, chromeBin, DATA } from './config.js';
import { ensureDir, sleep } from './util.js';

/**
 * Minimal Chrome DevTools Protocol client — no puppeteer, no npm install.
 * Node 24 ships a global WebSocket, so we talk CDP directly.
 */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }

  open(timeoutMs = 8000) {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connect failed'));
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function debugJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!res.ok) throw new Error(`devtools ${route} ${res.status}`);
  return res.json();
}

let statusCache = { at: 0, value: null };

export async function browserStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < 3000) return statusCache.value;
  const value = await browserStatusUncached();
  statusCache = { at: Date.now(), value };
  return value;
}

async function browserStatusUncached() {
  const { port } = settings().browser;
  try {
    const v = await debugJson(port, '/json/version');
    const tabs = (await debugJson(port, '/json/list')).filter(
      (t) => t.type === 'page' && !/^chrome:\/\//i.test(t.url || '') && !/^Omnibox|^DevTools/i.test(t.title || ''),
    );
    return { running: true, port, browser: v.Browser, tabs: tabs.map(tabInfo) };
  } catch {
    return { running: false, port, tabs: [], chrome: chromeBin() || null };
  }
}

function tabInfo(t) {
  return { id: t.id, title: (t.title || '').slice(0, 120), url: t.url, ws: t.webSocketDebuggerUrl };
}

/** Launch Chrome with a dedicated, persistent profile so your logins survive restarts. */
export async function launchBrowser({ url } = {}) {
  const cfg = settings().browser;
  const st = await browserStatus();
  if (!st.running) {
    const bin = chromeBin();
    if (!bin) throw new Error('Chrome/Edge not found. Install Chrome or set CHROME_PATH.');
    ensureDir(cfg.profileDir);
    const args = [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${cfg.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-features=Translate,MediaRouter',
      '--start-maximized',
      url || 'about:blank',
    ];
    if (cfg.headless) args.unshift('--headless=new');
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // Remember the pid so "quit" can actually kill the tree this profile started.
    launchedPid = child.pid;
    try {
      settings().browser.pid = child.pid;
    } catch {}
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const s2 = await browserStatus({ fresh: true });
      if (s2.running) return { ...s2, launched: true, pid: child.pid };
    }
    throw new Error('Chrome started but the debugging port never opened.');
  }
  if (url) await navigate(url);
  return { ...st, launched: false };
}

export async function listTabs() {
  const { port } = settings().browser;
  const tabs = (await debugJson(port, '/json/list')).filter(
    (t) => t.type === 'page' && !/^chrome:\/\//i.test(t.url || '') && !/^Omnibox|^DevTools/i.test(t.title || ''),
  );
  return tabs.map(tabInfo);
}

let activeTabId = null;
let launchedPid = null;

export function setActiveTab(id) {
  activeTabId = id || null;
  return activeTabId;
}

export async function activateTab(id) {
  setActiveTab(id);
  try {
    await fetch(`http://127.0.0.1:${settings().browser.port}/json/activate/${id}`);
  } catch {}
  return id;
}

async function attach(tabId) {
  const cfg = settings().browser;
  const tabs = await listTabs();
  if (!tabs.length) throw new Error('No browser tab available. Launch the browser first.');
  const wanted = tabId || activeTabId;
  const target = (wanted && tabs.find((t) => t.id === wanted)) || tabs[0];
  activeTabId = target.id;
  const cdp = new CDP(target.ws);
  await cdp.open();
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Runtime.enable').catch(() => {});
  return { cdp, tab: target };
}

export async function evaluate(expression, tabId) {
  const { cdp } = await attach(tabId);
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  } finally {
    cdp.close();
  }
}

export async function navigate(url) {
  const normalized = /^https?:\/\//i.test(url) ? url : 'https://' + String(url).replace(/^\/+/, '');
  const tabs = await listTabs().catch(() => []);
  if (!tabs.length) {
    await launchBrowser({ url: normalized });
    settings().browser.lastUrl = normalized;
    return { url: normalized, launched: true };
  }
  const { cdp } = await attach();
  try {
    await cdp.send('Page.navigate', { url: normalized });
    await sleep(900);
  } finally {
    cdp.close();
  }
  settings().browser.lastUrl = normalized;
  return { url: normalized };
}

export async function newTab(url = 'about:blank') {
  const { port } = settings().browser;
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) {
    // older Chrome builds accept GET
    const res2 = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`);
    if (!res2.ok) throw new Error('cannot open tab');
    const t = tabInfo(await res2.json());
    activeTabId = t.id;
    return t;
  }
  const t = tabInfo(await res.json());
  activeTabId = t.id;
  return t;
}

/* Browser-Use inspired interactive snapshot:
 * - broader interactive selector set + ARIA roles
 * - visibility / paint-order style filtering via bbox + computed style
 * - stable data-nx indices
 * - richer labels (role, name, aria, value, placeholder, bbox)
 * Keeps pure in-page evaluate (zero extra CDP round-trips, still zero npm deps).
 */
const SNAPSHOT_JS = `(() => {
  const INTERACTIVE = 'a,button,input,textarea,select,summary,option,' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],' +
    '[role=switch],[role=textbox],[role=combobox],[role=listbox],[role=option],[role=searchbox],' +
    '[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const all = Array.from(document.querySelectorAll(INTERACTIVE));
  // de-dupe nested interactive (prefer deepest actionable)
  const vis = [];
  const seen = new Set();
  for (const e of all) {
    if (seen.has(e)) continue;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    if (r.width < 2 || r.height < 2) continue;
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) continue;
    if (s.pointerEvents === 'none') continue;
    // skip elements fully covered / off-viewport slightly (keep near-viewport for scroll)
    if (r.bottom < -20 || r.top > (window.innerHeight + 40)) continue;
    seen.add(e);
    vis.push(e);
  }
  // clear previous indices then assign sequential
  document.querySelectorAll('[data-nx]').forEach(el => el.removeAttribute('data-nx'));
  vis.forEach((e, i) => {
    e.setAttribute('data-nx', String(i));
    e.setAttribute('data-nx-ref', '@e' + (i + 1));
  });
  const items = vis.slice(0, 350).map((e, i) => {
    const sensitiveInput = e.tagName === 'INPUT' && e.type === 'password';
    const role = e.getAttribute('role') || e.tagName.toLowerCase();
    const name = (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') &&
      (document.getElementById(e.getAttribute('aria-labelledby')) || {}).innerText ||
      e.innerText || (!sensitiveInput && e.value) || e.getAttribute('placeholder') || e.getAttribute('title') ||
      e.getAttribute('alt') || e.getAttribute('name') || '').toString().trim().replace(/\\s+/g, ' ').slice(0, 120);
    const r = e.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    return {
      i,
      ref: '@e' + (i + 1),
      tag: e.tagName.toLowerCase(),
      role,
      type: e.type || '',
      label: name,
      href: e.tagName === 'A' ? String(e.href || '').slice(0, 180) : '',
      placeholder: e.getAttribute('placeholder') || '',
      value: (!sensitiveInput && e.value !== undefined && e.tagName !== 'SELECT') ? String(e.value).slice(0, 80) : '',
      checked: !!e.checked,
      disabled: !!e.disabled,
      inView,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  });
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  // compact fingerprint for loop detection
  const fp = items.slice(0, 40).map(it => (it.ref || it.i) + ':' + it.role + ':' + (it.label || '').slice(0, 24)).join('|');
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 9000),
    textLen: text.length,
    items,
    itemCount: items.length,
    fingerprint: fp.slice(0, 800),
    scroll: { y: window.scrollY, h: document.documentElement.scrollHeight, vh: window.innerHeight }
  };
})()`;

/**
 * Phase 3/4: Browser-Use style deep snapshot.
 * - In-page interactive indices (data-nx) for reliable clicks
 * - CDP Accessibility.getFullAXTree for roles/names
 * - CDP DOMSnapshot.captureSnapshot with paint order / computed styles
 * Falls back cleanly if AX/Snapshot unavailable.
 */
export async function snapshot({ tabId, deep = true, viewportOnly = true } = {}) {
  const base = await evaluate(SNAPSHOT_JS, tabId);
  if (!base) return base;
  if (viewportOnly && Array.isArray(base.items)) {
    const filtered = base.items.filter((it) => it.inView !== false);
    if (filtered.length) {
      base.items = filtered;
      base.itemCount = filtered.length;
      base.viewportOnly = true;
    }
  }
  if (!deep) return base;

  try {
    const { cdp } = await attach(tabId);
    try {
      await cdp.send('Accessibility.enable').catch(() => {});
      await cdp.send('DOM.enable').catch(() => {});
      const [ax, snap] = await Promise.all([
        cdp.send('Accessibility.getFullAXTree', {}, 12000).catch(() => null),
        cdp
          .send(
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: ['visibility', 'display', 'opacity', 'pointer-events'],
              includePaintOrder: true,
              includeDOMRects: true,
            },
            15000,
          )
          .catch(() => null),
      ]);

      const axHints = [];
      if (ax?.nodes?.length) {
        for (const n of ax.nodes) {
          const role = n.role?.value || n.role || '';
          const name = n.name?.value || n.name || '';
          if (!role && !name) continue;
          if (['generic', 'InlineTextBox', 'paragraph', 'LineBreak', 'none', 'RootWebArea', 'ScrollArea'].includes(role)) continue;
          if (!name && !['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch'].includes(role)) continue;
          axHints.push({
            role: String(role).slice(0, 40),
            name: String(name).slice(0, 120),
            ignored: !!n.ignored,
          });
          if (axHints.length >= 200) break;
        }
      }

      const paintStats = { nodes: 0, paintOrders: 0, hasSnapshot: !!snap };
      try {
        if (snap?.documents?.length) {
          const doc = snap.documents[0];
          const nodes = doc.nodes || {};
          const layout = doc.layout || {};
          paintStats.nodes = (nodes.backendNodeId || []).length || 0;
          paintStats.paintOrders = (layout.paintOrders || []).length || 0;
        }
      } catch {}

      if (!axHints.length && !snap) return { ...base, ax: false, paint: false };

      const items = (base.items || []).map((it) => {
        if (it.label && it.label.length > 8) return it;
        const needle = (it.label || it.placeholder || it.type || it.tag || '').toLowerCase();
        const hit = axHints.find(
          (h) =>
            h.name &&
            (h.role === it.role ||
              h.role === it.tag ||
              (needle && h.name.toLowerCase().includes(needle)) ||
              (!needle && ['button', 'link', 'textbox'].includes(h.role))),
        );
        if (hit && hit.name) return { ...it, label: hit.name, axRole: hit.role, ax: true };
        return it;
      });

      return {
        ...base,
        items,
        ax: axHints.length > 0,
        axHintCount: axHints.length,
        axSample: axHints.slice(0, 30),
        paint: !!snap,
        paintStats,
      };
    } finally {
      cdp.close();
    }
  } catch {
    return { ...base, ax: false, paint: false };
  }
}

export async function screenshot({ tabId, full = false } = {}) {
  const { cdp } = await attach(tabId);
  try {
    const params = { format: 'png', captureBeyondViewport: !!full };
    const r = await cdp.send('Page.captureScreenshot', params, 45000);
    ensureDir(path.join(DATA, 'shots'));
    const file = path.join(DATA, 'shots', `shot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return { file: path.basename(file), base64: r.data };
  } finally {
    cdp.close();
  }
}

async function focusIndex(i, tabId) {
  await evaluate(
    `(() => { const el = document.querySelector('[data-nx="${i}"]'); if (!el) return 'missing'; el.scrollIntoView({block:'center'}); el.focus({preventScroll:true}); return 'ok'; })()`,
    tabId,
  );
}

export async function click({ index, text, ref, tabId }) {
  if (ref != null && (index === undefined || index === null)) {
    const m = String(ref).match(/^@?e(\d+)$/i);
    if (m) index = Number(m[1]) - 1;
  }
  if (index !== undefined && index !== null) {
    const r = await evaluate(
      `(() => { const el = document.querySelector('[data-nx="${index}"]'); if (!el) return 'missing'; el.scrollIntoView({block:'center'}); el.click(); return 'clicked ' + el.tagName; })()`,
      tabId,
    );
    await sleep(450);
    return r;
  }
  if (text) {
    const needle = JSON.stringify(String(text).toLowerCase());
    const r = await evaluate(
      `(() => {
        const els = Array.from(document.querySelectorAll('a,button,[role=button],[data-nx]'));
        const el = els.find(e => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(${needle}));
        if (!el) return 'not found';
        el.scrollIntoView({block:'center'}); el.click(); return 'clicked ' + el.tagName;
      })()`,
      tabId,
    );
    await sleep(450);
    return r;
  }
  throw new Error('click needs index or text');
}

export async function type({ index, text, tabId, submit = false }) {
  if (index === undefined) throw new Error('type needs an element index from snapshot');
  await focusIndex(index, tabId);
  const { cdp } = await attach(tabId);
  try {
    await cdp.send('Input.insertText', { text: String(text) });
    if (submit) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
        text: '\r',
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
      await sleep(700);
    }
  } finally {
    cdp.close();
  }
  return 'typed';
}

export async function press({ key, tabId }) {
  const k = parseKeySpec(key);
  const probe = `(() => ({
    href: location.href,
    len: document.body ? document.body.innerText.length : 0,
    value: document.activeElement && document.activeElement.type === 'password' ? '' :
      (document.activeElement ? (document.activeElement.value || '') : ''),
    tag: document.activeElement ? document.activeElement.tagName : ''
  }))()`;
  const before = await evaluate(probe, tabId).catch(() => null);

  const { cdp } = await attach(tabId);
  try {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      key: k.key,
      code: k.code,
      modifiers: k.modifiers,
      ...(k.text === undefined ? {} : { text: k.text }),
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      key: k.key,
      code: k.code,
      modifiers: k.modifiers,
    });
  } finally {
    cdp.close();
  }
  await sleep(400);

  // Some sites only react to a synthetic DOM keyboard event (React handlers keyed on keyCode).
  // Only fire it when the trusted key produced no observable change, so nothing submits twice.
  if (k.key === 'Enter' && k.modifiers === 0 && before) {
    const after = await evaluate(probe, tabId).catch(() => null);
    const unchanged =
      after && after.href === before.href && Math.abs(after.len - before.len) < 20 && after.value === before.value;
    if (unchanged) {
      await evaluate(
        `(() => {
          const el = document.activeElement || document.body;
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return 'synthetic';
        })()`,
        tabId,
      );
      await sleep(700);
    }
  }
  return 'pressed ' + key;
}

function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('press needs a supported key name');
  const modifiersByName = { ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, cmd: 4, command: 4 };
  let modifiers = 0;
  let base = '';
  for (const part of parts) {
    const modifier = modifiersByName[part.toLowerCase()];
    if (modifier !== undefined) {
      if (modifiers & modifier) throw new Error(`duplicate keyboard modifier: ${part}`);
      modifiers |= modifier;
    } else if (base) {
      throw new Error('press accepts one key with optional Ctrl, Alt, Shift, or Meta modifiers');
    } else {
      base = part;
    }
  }
  if (!base) throw new Error('press needs a key after its modifiers');

  const named = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13, text: modifiers ? undefined : '\r' },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    Space: { key: ' ', code: 'Space', vk: 32, text: modifiers ? undefined : ' ' },
    PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    End: { key: 'End', code: 'End', vk: 35 },
  };
  const match = Object.keys(named).find((name) => name.toLowerCase() === base.toLowerCase());
  let keyInfo = match ? named[match] : null;
  if (!keyInfo && /^[a-z]$/i.test(base)) {
    const letter = base.toUpperCase();
    keyInfo = { key: modifiers & 8 ? letter : letter.toLowerCase(), code: `Key${letter}`, vk: letter.charCodeAt(0) };
  } else if (!keyInfo && /^\d$/.test(base)) {
    keyInfo = { key: base, code: `Digit${base}`, vk: base.charCodeAt(0) };
  }
  if (!keyInfo) throw new Error(`unsupported browser key: ${base}`);
  return { ...keyInfo, modifiers };
}

export async function scroll({ y = 800, tabId }) {
  return evaluate(`(window.scrollBy(0, ${Number(y) || 800}), window.scrollY)`, tabId);
}

/* --------------------------- computer-use primitives ---------------------- */

/** Real cursor movement, in steps, so the OS-level cursor actually travels. */
export async function mouseMove({ x, y, steps = 10, tabId } = {}) {
  const { cdp } = await attach(tabId);
  try {
    const cur = await cdp
      .send('Runtime.evaluate', { expression: '({x: window.__nxMouseX || 0, y: window.__nxMouseY || 0})', returnByValue: true })
      .then((r) => r.result?.value || { x: 0, y: 0 })
      .catch(() => ({ x: 0, y: 0 }));
    const from = { x: Number(cur.x) || 0, y: Number(cur.y) || 0 };
    const to = { x: Number(x) || 0, y: Number(y) || 0 };
    const n = Math.max(2, Math.min(Number(steps) || 10, 40));
    for (let i = 1; i <= n; i++) {
      const px = Math.round(from.x + ((to.x - from.x) * i) / n);
      const py = Math.round(from.y + ((to.y - from.y) * i) / n);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0 });
      await sleep(12);
    }
    await cdp.send('Runtime.evaluate', { expression: `window.__nxMouseX=${to.x}; window.__nxMouseY=${to.y}` }).catch(() => {});
  } finally {
    cdp.close();
  }
  return { x, y };
}

export async function mouseClick({ x, y, button = 'left', clickCount = 1, tabId } = {}) {
  await mouseMove({ x, y, tabId });
  const { cdp } = await attach(tabId);
  try {
    const base = { x: Number(x), y: Number(y), button, clickCount };
    const mask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: mask });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  } finally {
    cdp.close();
  }
  await sleep(300);
  return `clicked ${x},${y}`;
}

export async function hover({ x, y, tabId } = {}) {
  await mouseMove({ x, y, tabId });
  await sleep(350);
  return `hovered ${x},${y}`;
}

export async function rightClick({ x, y, tabId } = {}) {
  const r = await mouseClick({ x, y, button: 'right', tabId });
  return `right-clicked ${x},${y}`;
}

export async function doubleClick({ x, y, tabId } = {}) {
  // A real dblclick is two press/release pairs; Chrome derives the event from clickCount, not from one
  // pointer press with count 2.
  await mouseClick({ x, y, clickCount: 1, tabId });
  await sleep(90);
  await mouseClick({ x, y, clickCount: 2, tabId });
  return `double-clicked ${x},${y}`;
}

/** Press, travel with the button held, release. The only way to move sliders and drag-and-drop. */
export async function drag({ fromX, fromY, toX, toY, steps = 12, tabId } = {}) {
  await mouseMove({ x: fromX, y: fromY, tabId });
  const { cdp } = await attach(tabId);
  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Number(fromX), y: Number(fromY), button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    const n = Math.max(3, Math.min(Number(steps) || 12, 40));
    for (let i = 1; i <= n; i++) {
      const px = Math.round(Number(fromX) + ((Number(toX) - Number(fromX)) * i) / n);
      const py = Math.round(Number(fromY) + ((Number(toY) - Number(fromY)) * i) / n);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 });
      await sleep(18);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Number(toX), y: Number(toY), button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    cdp.close();
  }
  await sleep(300);
  return `dragged ${fromX},${fromY} -> ${toX},${toY}`;
}

/** Real wheel events — needed for lazy-loaded lists and editors that listen to wheel, not scrollTop. */
export async function wheel({ deltaY = 600, deltaX = 0, x = 640, y = 360, tabId } = {}) {
  const { cdp } = await attach(tabId);
  try {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Number(x),
      y: Number(y),
      deltaX: Number(deltaX) || 0,
      deltaY: Number(deltaY) || 0,
      buttons: 0,
    });
  } finally {
    cdp.close();
  }
  await sleep(400);
  const scrollY = await evaluate('Math.round(window.scrollY)', tabId).catch(() => null);
  return { deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0, scrollY };
}

/** Poll until text or a selector appears. This is what makes form automation reliable. */
export async function waitFor({ text, selector, timeoutMs = 20000, tabId } = {}) {
  const deadline = Date.now() + Math.min(Number(timeoutMs) || 20000, 120000);
  const probe = selector
    ? `!!document.querySelector(${JSON.stringify(selector)})`
    : `document.body ? document.body.innerText.includes(${JSON.stringify(String(text || ''))}) : false`;
  while (Date.now() < deadline) {
    const hit = await evaluate(probe, tabId).catch(() => false);
    if (hit) return { found: true, waited: Date.now() - (deadline - timeoutMs) };
    await sleep(350);
  }
  return { found: false, waited: Number(timeoutMs) };
}

/**
 * Fill a field by what the *human* sees (label, placeholder, aria-label, name) rather than by index.
 * LMS forms rename their inputs constantly; labels are stable.
 */
export async function fillByLabel({ label, value, tabId } = {}) {
  const needle = JSON.stringify(String(label || '').toLowerCase());
  const focus = `(() => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const fields = [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')];
    const byLabelText = (f) => {
      if (f.id) {
        const l = document.querySelector('label[for="' + f.id + '"]');
        if (l) return norm(l.innerText);
      }
      const wrap = f.closest('label');
      if (wrap) return norm(wrap.innerText);
      return '';
    };
    const f = fields.find((x) => {
      const hay = [byLabelText(x), norm(x.getAttribute('aria-label')), norm(x.getAttribute('placeholder')), norm(x.getAttribute('name')), norm(x.id)].join(' ');
      return hay.includes(${needle});
    });
    if (!f) return 'not-found';
    f.scrollIntoView({ block: 'center' });
    f.focus();
    return f.tagName.toLowerCase();
  })()`;
  const found = await evaluate(focus, tabId);
  if (found === 'not-found') return { ok: false, error: `no field matching "${label}"` };
  if (found === 'select') {
    await evaluate(
      `(() => { const s = document.activeElement; const o = [...s.options].find(o => (o.text||'').toLowerCase().includes(${JSON.stringify(String(value).toLowerCase())}) || o.value.toLowerCase().includes(${JSON.stringify(String(value).toLowerCase())})); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', {bubbles:true})); return 'set'; } return 'no-option'; })()`,
      tabId,
    );
    return { ok: true, field: label, via: 'select' };
  }
  const { cdp } = await attach(tabId);
  try {
    await cdp.send('Input.insertText', { text: String(value ?? '') });
  } finally {
    cdp.close();
  }
  return { ok: true, field: label, via: found };
}

/** Attach a real file to an <input type=file> — the step every lecture/assignment upload needs. */
export async function upload({ selector = 'input[type=file]', path: filePath, tabId } = {}) {
  if (!filePath) throw new Error('upload needs a file path');
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const { cdp } = await attach(tabId);
  try {
    const handle = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });
    const objectId = handle.result?.objectId;
    if (!objectId || handle.result?.subtype === 'null') throw new Error(`no file input matching ${selector}`);
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], objectId });
  } finally {
    cdp.close();
  }
  await sleep(400);
  return { ok: true, attached: path.basename(filePath), selector };
}

/** Same-origin iframes are where LMS editors live. */
export async function frames({ tabId } = {}) {
  return evaluate(
    `(() => [...document.querySelectorAll('iframe')].map((f, i) => ({ i, src: f.src || '(inline)', title: f.title || '', sameOrigin: (() => { try { return Boolean(f.contentDocument) } catch { return false } })() })))()`,
    tabId,
  );
}

export async function evalInFrame({ index = 0, expression, tabId } = {}) {
  return evaluate(
    `(() => { const f = document.querySelectorAll('iframe')[${Number(index) || 0}]; if (!f) return 'no-frame'; try { return (new Function('return (' + ${JSON.stringify(String(expression || 'true'))} + ')')).call(f.contentWindow); } catch (e) { return 'error: ' + e.message; } })()`,
    tabId,
  );
}

export async function sleepFor({ ms = 1500 }) {
  await sleep(Math.min(Number(ms) || 1500, 20000));
  return 'waited';
}

export async function closeTab(tabId) {
  const { port } = settings().browser;
  await fetch(`http://127.0.0.1:${port}/json/close/${tabId}`);
  if (activeTabId === tabId) activeTabId = null;
  return 'closed';
}

export async function stopBrowser() {
  const { port } = settings().browser;
  let asked = false;
  try {
    const v = await debugJson(port, '/json/version');
    const ws = new CDP(v.webSocketDebuggerUrl);
    await ws.open();
    await ws.send('Browser.close').catch(() => {});
    ws.close();
    asked = true;
  } catch {}
  // Browser.close is a request, not a guarantee. Wait, then kill the tree we started.
  for (let i = 0; i < 12; i++) {
    await sleep(300);
    const st = await browserStatus({ fresh: true });
    if (!st.running) return { stopped: true, method: asked ? 'cdp' : 'already-stopped' };
  }
  const pid = launchedPid || settings().browser.pid;
  if (pid) spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
  else spawn('taskkill', ['/F', '/FI', 'IMAGENAME eq chrome.exe'], { windowsHide: true });
  await sleep(1500);
  const after = await browserStatus({ fresh: true });
  return { stopped: !after.running, method: 'pid-kill', pid: pid || null, stillRunning: after.running };
}
