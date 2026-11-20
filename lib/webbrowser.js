/**
 * Built-in browser engine — no Chrome/Edge required.
 * Fetches pages server-side, extracts interactive elements, simulates navigation/forms.
 * Snapshot shape mirrors CDP browser so the agent tool API stays the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, truncate, sleep } from './util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 NexusBuiltin/7.0';

/** Simple cookie jar: host -> Map(name -> {value, path}) */
const cookieJar = new Map();

function jarKey(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function storeCookies(url, res) {
  const host = jarKey(url);
  if (!host) return;
  // undici/node fetch: getSetCookie if available
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const single = res.headers.get('set-cookie');
  const list = raw.length ? raw : single ? [single] : [];
  if (!cookieJar.has(host)) cookieJar.set(host, new Map());
  const jar = cookieJar.get(host);
  for (const line of list) {
    const part = String(line).split(';')[0];
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    jar.set(name, value);
  }
}
function cookieHeader(url) {
  const host = jarKey(url);
  const jar = cookieJar.get(host);
  if (!jar || !jar.size) return '';
  return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
}


/** @type {Map<string, {id:string,url:string,title:string,html:string,text:string,items:any[],history:string[]}>} */
const tabs = new Map();
let activeId = null;
let seq = 0;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function absUrl(base, href) {
  if (!href) return null;
  href = decodeEntities(href).trim();
  if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('#')) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Extract interactive elements from HTML (links, buttons, inputs, forms).
 * Assigns sequential indices like CDP snapshot.
 */
function extractItems(html, pageUrl) {
  const items = [];
  const push = (it) => {
    if (items.length >= 350) return;
    items.push({ i: items.length, ...it });
  };

  // anchors
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html)) && items.length < 350) {
    const attrs = m[1];
    const href = (attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1];
    const url = absUrl(pageUrl, href);
    if (!url) continue;
    const label = htmlToText(m[2]).slice(0, 120) || url;
    const aria = (attrs.match(/\baria-label\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    push({
      tag: 'a',
      role: 'link',
      type: '',
      label: (aria || label).slice(0, 120),
      href: url.slice(0, 300),
      placeholder: '',
      value: '',
      checked: false,
      disabled: false,
      action: 'navigate',
      targetUrl: url,
    });
  }

  // buttons
  const bRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = bRe.exec(html)) && items.length < 350) {
    const attrs = m[1];
    if (/\bdisabled\b/i.test(attrs)) continue;
    const type = ((attrs.match(/\btype\s*=\s*["']([^"']*)["']/i) || [])[1] || 'submit').toLowerCase();
    const label = htmlToText(m[2]).slice(0, 120);
    const aria = (attrs.match(/\baria-label\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const formAction = (attrs.match(/\bformaction\s*=\s*["']([^"']*)["']/i) || [])[1];
    push({
      tag: 'button',
      role: 'button',
      type,
      label: (aria || label || type).slice(0, 120),
      href: '',
      placeholder: '',
      value: '',
      checked: false,
      disabled: false,
      action: type === 'submit' ? 'submit' : 'button',
      formAction: formAction ? absUrl(pageUrl, formAction) : null,
    });
  }

  // inputs
  const iRe = /<input\b([^>]*?)\/?>/gi;
  while ((m = iRe.exec(html)) && items.length < 350) {
    const attrs = m[1];
    const type = ((attrs.match(/\btype\s*=\s*["']([^"']*)["']/i) || [])[1] || 'text').toLowerCase();
    if (['hidden', 'submit', 'image', 'button', 'reset'].includes(type)) {
      if (type === 'submit' || type === 'button' || type === 'image') {
        const val = (attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1] || type;
        push({
          tag: 'input',
          role: 'button',
          type,
          label: val.slice(0, 120),
          href: '',
          placeholder: '',
          value: val,
          checked: false,
          disabled: /\bdisabled\b/i.test(attrs),
          action: 'submit',
        });
      }
      continue;
    }
    const name = (attrs.match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const placeholder = (attrs.match(/\bplaceholder\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const aria = (attrs.match(/\baria-label\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const value = type === 'password' ? '' : (attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    push({
      tag: 'input',
      role: type === 'checkbox' || type === 'radio' ? type : 'textbox',
      type,
      label: (aria || placeholder || name || id || type).slice(0, 120),
      href: '',
      placeholder,
      value,
      name,
      id,
      checked: /\bchecked\b/i.test(attrs),
      disabled: /\bdisabled\b/i.test(attrs),
      action: 'fill',
    });
  }

  // textareas
  const tRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = tRe.exec(html)) && items.length < 350) {
    const attrs = m[1];
    const name = (attrs.match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const placeholder = (attrs.match(/\bplaceholder\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    push({
      tag: 'textarea',
      role: 'textbox',
      type: 'textarea',
      label: (placeholder || name || 'textarea').slice(0, 120),
      href: '',
      placeholder,
      value: htmlToText(m[2]).slice(0, 200),
      name,
      checked: false,
      disabled: /\bdisabled\b/i.test(attrs),
      action: 'fill',
    });
  }

  // select
  const sRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = sRe.exec(html)) && items.length < 350) {
    const attrs = m[1];
    const name = (attrs.match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].slice(0, 20).map((o) => ({
      value: (o[1].match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1] || htmlToText(o[2]),
      label: htmlToText(o[2]).slice(0, 80),
    }));
    push({
      tag: 'select',
      role: 'combobox',
      type: 'select',
      label: (name || 'select').slice(0, 120),
      href: '',
      placeholder: '',
      value: opts[0]?.value || '',
      name,
      options: opts,
      checked: false,
      disabled: /\bdisabled\b/i.test(attrs),
      action: 'fill',
    });
  }

  return items;
}

async function fetchPage(url, { method = 'GET', body, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const cookie = cookieHeader(url);
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    });
    storeCookies(url, res);
    // also store for final URL after redirects
    try { storeCookies(res.url || url, res); } catch {}
    const buf = Buffer.from(await res.arrayBuffer());
    let html = buf.toString('utf8');
    // basic charset guess
    const ct = res.headers.get('content-type') || '';
    if (/charset\s*=\s*utf-8/i.test(ct) || /^\s*</.test(html)) {
      /* ok */
    } else {
      try {
        html = buf.toString('latin1');
      } catch {}
    }
    return { url: res.url || url, status: res.status, html, contentType: ct };
  } finally {
    clearTimeout(timer);
  }
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

function getTab(id) {
  const t = tabs.get(id || activeId);
  if (!t) throw new Error('No built-in browser tab. Use action=launch or open first.');
  return t;
}

export function status() {
  return {
    engine: 'builtin',
    running: tabs.size > 0,
    activeId,
    tabs: [...tabs.values()].map((t) => ({ id: t.id, title: t.title, url: t.url })),
  };
}

export async function launch({ url = 'about:blank' } = {}) {
  return open(url);
}

export async function open(url) {
  const normalized =
    !url || url === 'about:blank'
      ? 'about:blank'
      : /^https?:\/\//i.test(url)
        ? url
        : 'https://' + String(url).replace(/^\/+/, '');

  let html = '';
  let finalUrl = normalized;
  let title = 'Blank';
  let items = [];
  let text = '';

  if (normalized !== 'about:blank') {
    const page = await fetchPage(normalized);
    html = page.html;
    finalUrl = page.url;
    title = titleOf(html) || finalUrl;
    items = extractItems(html, finalUrl);
    text = htmlToText(html).slice(0, 12000);
  }

  const id = 'wb_' + ++seq;
  const tab = {
    id,
    url: finalUrl,
    title,
    html,
    text,
    items,
    history: [finalUrl],
    formState: {},
  };
  tabs.set(id, tab);
  activeId = id;
  return { ok: true, engine: 'builtin', id, url: finalUrl, title, itemCount: items.length };
}

export async function navigate(url, tabId) {
  const t = getTab(tabId);
  const normalized = /^https?:\/\//i.test(url) ? url : 'https://' + String(url).replace(/^\/+/, '');
  const page = await fetchPage(normalized);
  t.url = page.url;
  t.html = page.html;
  t.title = titleOf(page.html) || page.url;
  t.items = extractItems(page.html, page.url);
  t.text = htmlToText(page.html).slice(0, 12000);
  t.history.push(page.url);
  t.formState = {};
  return { ok: true, engine: 'builtin', url: t.url, title: t.title, itemCount: t.items.length };
}

export function listTabs() {
  return status().tabs;
}

export function activateTab(id) {
  if (!tabs.has(id)) throw new Error('unknown tab');
  activeId = id;
  return id;
}

export function closeTab(id) {
  const tid = id || activeId;
  tabs.delete(tid);
  if (activeId === tid) activeId = tabs.keys().next().value || null;
  return tid;
}

export function snapshot({ tabId } = {}) {
  const t = getTab(tabId);
  const fp = t.items
    .slice(0, 40)
    .map((it) => it.i + ':' + it.role + ':' + (it.label || '').slice(0, 24))
    .join('|');
  return {
    engine: 'builtin',
    url: t.url,
    title: t.title,
    text: t.text.slice(0, 9000),
    textLen: t.text.length,
    items: t.items,
    itemCount: t.items.length,
    fingerprint: fp.slice(0, 800),
    scroll: { y: 0, h: 0, vh: 0 },
    ax: false,
    paint: false,
    note: 'Built-in engine: no Chrome required. Clicks follow links / fill form fields; JS-heavy apps may need CDP Chrome.',
  };
}

export async function click({ index, text, tabId } = {}) {
  const t = getTab(tabId);
  let item = null;
  if (index !== undefined && index !== null) {
    item = t.items.find((x) => x.i === Number(index));
    if (!item) throw new Error(`no element index ${index}`);
  } else if (text) {
    const needle = String(text).toLowerCase();
    item = t.items.find((x) => (x.label || '').toLowerCase().includes(needle));
    if (!item) throw new Error(`no element matching "${text}"`);
  } else {
    throw new Error('click needs index or text');
  }

  if (item.action === 'navigate' && item.targetUrl) {
    return navigate(item.targetUrl, t.id);
  }
  if (item.action === 'submit' || item.type === 'submit') {
    return submitNearestForm(t, item);
  }
  // button without clear form — try submit
  if (item.tag === 'button') {
    return submitNearestForm(t, item);
  }
  return { ok: true, clicked: item.i, label: item.label, note: 'no navigation target; use type on inputs then click submit' };
}

export async function type({ index, text, tabId, submit = false } = {}) {
  const t = getTab(tabId);
  if (index === undefined) throw new Error('type needs element index');
  const item = t.items.find((x) => x.i === Number(index));
  if (!item) throw new Error(`no element index ${index}`);
  if (item.action !== 'fill' && item.role !== 'textbox' && item.tag !== 'select') {
    throw new Error(`element ${index} is not fillable (${item.tag})`);
  }
  const key = item.name || item.id || `idx_${item.i}`;
  t.formState[key] = String(text ?? '');
  item.value = item.type === 'password' ? '' : String(text ?? '');
  if (submit) return submitNearestForm(t, item);
  return { ok: true, typed: true, index: item.i, field: key };
}

export async function press({ key, tabId } = {}) {
  if (String(key).toLowerCase() === 'enter') {
    const t = getTab(tabId);
    return submitNearestForm(t, null);
  }
  throw new Error('built-in browser only supports Enter for form submission; launch persistent Chrome for keyboard input');
}

export async function scroll() {
  return { ok: true, y: 0, note: 'built-in engine has no viewport scroll' };
}

export async function screenshot({ tabId } = {}) {
  const t = getTab(tabId);
  // Save a text "screenshot" artifact — no real pixels without a browser engine
  ensureDir(path.join(DATA, 'shots'));
  const file = path.join(DATA, 'shots', `builtin-${Date.now()}.txt`);
  const body = `BUILTIN BROWSER SNAPSHOT\nURL: ${t.url}\nTITLE: ${t.title}\n\n${t.text.slice(0, 8000)}\n`;
  fs.writeFileSync(file, body);
  return { ok: true, file: path.basename(file), engine: 'builtin', note: 'text snapshot only (no Chrome)' };
}

async function submitNearestForm(tab, item) {
  // Find first form in HTML and POST/GET with formState
  const formMatch = tab.html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!formMatch) {
    // fallback: if we have a search-like field, try common search URL patterns
    const q = Object.values(tab.formState)[0];
    if (q && /google|bing|duckduckgo|search/i.test(tab.url)) {
      const u = new URL(tab.url);
      u.searchParams.set('q', q);
      return navigate(u.href, tab.id);
    }
    return { ok: false, error: 'no form found on page to submit' };
  }
  const attrs = formMatch[1];
  const method = ((attrs.match(/\bmethod\s*=\s*["']([^"']*)["']/i) || [])[1] || 'GET').toUpperCase();
  let action = (attrs.match(/\baction\s*=\s*["']([^"']*)["']/i) || [])[1] || tab.url;
  if (item?.formAction) action = item.formAction;
  action = absUrl(tab.url, action) || tab.url;

  // collect default fields from form HTML
  const fields = { ...tab.formState };
  const inputRe = /<input\b([^>]*?)\/?>/gi;
  let im;
  while ((im = inputRe.exec(formMatch[2]))) {
    const a = im[1];
    const type = ((a.match(/\btype\s*=\s*["']([^"']*)["']/i) || [])[1] || 'text').toLowerCase();
    const name = (a.match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!name || type === 'submit' || type === 'button' || type === 'image' || type === 'file') continue;
    if (fields[name] !== undefined) continue;
    if (type === 'checkbox' || type === 'radio') {
      if (/\bchecked\b/i.test(a)) fields[name] = (a.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1] || 'on';
      continue;
    }
    const val = (a.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (val !== undefined) fields[name] = val;
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);

  if (method === 'GET') {
    const u = new URL(action);
    for (const [k, v] of params) u.searchParams.set(k, v);
    return navigate(u.href, tab.id);
  }

  const page = await fetchPage(action, {
    method: 'POST',
    body: params.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  tab.url = page.url;
  tab.html = page.html;
  tab.title = titleOf(page.html) || page.url;
  tab.items = extractItems(page.html, page.url);
  tab.text = htmlToText(page.html).slice(0, 12000);
  tab.history.push(page.url);
  tab.formState = {};
  return { ok: true, engine: 'builtin', submitted: true, url: tab.url, title: tab.title, itemCount: tab.items.length };
}

export function closeAll() {
  tabs.clear();
  activeId = null;
  return { ok: true };
}
