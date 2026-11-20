import { settings, saveSettings, REDIRECT_URI } from './config.js';
import { fetchWithTimeout, htmlToText, truncate } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function isConnected() {
  return accounts().some((a) => a.refreshToken);
}

/**
 * Multiple Google accounts.
 *
 * A Google session is one identity at a time — they cannot be merged, and pretending otherwise would
 * be an SSO bypass. What we *can* do is keep several authorised accounts side by side and switch the
 * active one, which is what "I have many Google accounts" actually needs.
 */
export function accounts() {
  const g = settings().google || {};
  const list = Array.isArray(g.accounts) ? [...g.accounts] : [];
  // Seed from the legacy single-account fields so existing installs keep working.
  if (!list.length && g.refreshToken) list.push({ id: 'default', label: 'primary', email: g.email || '', refreshToken: g.refreshToken });
  return list;
}

export function activeAccount() {
  const g = settings().google || {};
  const list = accounts();
  return list.find((a) => a.id === g.activeId) || list[0] || null;
}

export function switchAccount(id) {
  const list = accounts();
  const hit = list.find((a) => a.id === id);
  if (!hit) throw new Error('no such Google account');
  saveSettings({ google: { activeId: hit.id, email: hit.email, refreshToken: hit.refreshToken } });
  return { ok: true, active: { id: hit.id, label: hit.label, email: hit.email }, accounts: list.map((a) => ({ id: a.id, label: a.label, email: a.email })) };
}

export function removeAccount(id) {
  const list = accounts().filter((a) => a.id !== id);
  saveSettings({ google: { accounts: list, activeId: list[0]?.id || '', refreshToken: list[0]?.refreshToken || '', email: list[0]?.email || '' } });
  return { ok: true, accounts: list.map((a) => ({ id: a.id, label: a.label, email: a.email })) };
}

export function renameAccount(id, label) {
  const list = accounts().map((a) => (a.id === id ? { ...a, label: String(label).slice(0, 40) } : a));
  saveSettings({ google: { accounts: list } });
  return { ok: true, accounts: list.map((a) => ({ id: a.id, label: a.label, email: a.email })) };
}

export function authUrl() {
  const g = settings().google;
  if (!g.clientId || !g.clientSecret) {
    throw new Error(
      'Add a Google OAuth Client ID and Secret first (Settings → Google). Google Cloud Console → APIs & Services → Credentials → Create OAuth client → Desktop/Web app, redirect URI ' +
        REDIRECT_URI,
    );
  }  const params = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: g.scopes.join(' '),
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(code) {
  const g = settings().google;
  const body = new URLSearchParams({
    code,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'token exchange failed');

  const refresh = data.refresh_token || g.refreshToken;
  const me = await apiWith(data.access_token, 'https://www.googleapis.com/oauth2/v3/userinfo').catch(() => null);
  const email = me?.email || g.email || '';
  const label = g.pendingLabel || email.split('@')[0] || 'google';
  const list = accounts();
  const id = `g_${email.replace(/[^a-z0-9]/gi, '').slice(0, 18) || Date.now()}`;
  const next = [...list.filter((a) => a.id !== id), { id, label, email, refreshToken: refresh, addedAt: new Date().toISOString() }];
  saveSettings({
    google: {
      accounts: next,
      activeId: id,
      email,
      refreshToken: refresh,
      accessToken: data.access_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000 - 60000,
      pendingLabel: '',
    },
  });
  return { email, label, id, scope: data.scope };
}

/** Small helper so we can read the profile before saving it. */
async function apiWith(token, url) {
  const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` } }, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function accessToken() {
  const active = activeAccount();
  const g = settings().google;
  if (!active?.refreshToken) throw new Error('Google is not connected yet. Open Connect → Google.');
  if (g.accessToken && g.expiry && Date.now() < g.expiry) return g.accessToken;
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    refresh_token: active.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google refresh failed: ${data.error_description || data.error}`);
  saveSettings({ google: { accessToken: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 - 60000 } });
  return data.access_token;
}

export async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const token = await accessToken();
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 45000);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${url.split('?')[0]} ${res.status}: ${(data.error?.message || text).slice(0, 300)}`);
  }
  return data;
}

/* ---------------------------------- Gmail --------------------------------- */

function header(msg, name) {
  return (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeB64(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walkParts(part, out = []) {
  if (!part) return out;
  if (part.body?.data && /text\/(plain|html)/.test(part.mimeType || '')) {
    out.push({ mime: part.mimeType, text: decodeB64(part.body.data) });
  }
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}

export async function gmailSearch(q, max = 8) {
  const list = await api(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q || '')}`,
  );
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await api(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    out.push({
      id,
      threadId: msg.threadId,
      from: header(msg, 'From'),
      to: header(msg, 'To'),
      subject: header(msg, 'Subject'),
      date: header(msg, 'Date'),
      snippet: truncate(htmlToText(msg.snippet || ''), 200),
      unread: (msg.labelIds || []).includes('UNREAD'),
    });
  }
  return out;
}

export async function gmailRead(id) {
  const msg = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
  const parts = walkParts(msg.payload);
  const plain = parts.find((p) => p.mime === 'text/plain') || parts.find((p) => p.mime === 'text/html');
  const body = plain ? (plain.mime === 'text/html' ? htmlToText(plain.text) : plain.text) : msg.snippet || '';
  return {
    id,
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    subject: header(msg, 'Subject'),
    date: header(msg, 'Date'),
    body: truncate(body, 6000),
    attachments: (msg.payload?.parts || []).filter((p) => p.filename).map((p) => p.filename),
  };
}

function toBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailSend({ to, subject, body, cc, bcc }) {
  if (!to) throw new Error('gmail send needs a "to" address');
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject || '(no subject)'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body || '',
  ].filter(Boolean);
  const raw = toBase64Url(lines.join('\r\n'));
  const sent = await api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: { raw },
  });
  return { id: sent.id, to, subject };
}

/* -------------------------------- Calendar -------------------------------- */

export async function calendarList({ days = 7, max = 15 } = {}) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 864e5).toISOString();
  const data = await api(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=${max}`,
  );
  return (data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || '(untitled)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || '',
    attendees: (e.attendees || []).map((a) => a.email).slice(0, 8),
  }));
}

export async function calendarCreate({ title, start, end, description, attendees }) {
  if (!title || !start) throw new Error('calendar create needs title and start (ISO datetime)');
  const body = {
    summary: title,
    description: description || '',
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(end || Date.now() + 3600e3).toISOString() },
    attendees: (attendees || []).map((email) => ({ email })),
  };
  const e = await api('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', body });
  return { id: e.id, htmlLink: e.htmlLink, start: body.start.dateTime };
}

/* ---------------------------------- Drive --------------------------------- */

/** List files, optionally inside the hidden appDataFolder, optionally name-filtered. */
export async function driveList({ appDataFolder = false, nameContains = '', pageSize = 20 } = {}) {
  const parts = [];
  if (appDataFolder) parts.push("spaces='appDataFolder'");
  if (nameContains) parts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
  parts.push('trashed = false');
  const data = await api(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(parts.join(' and '))}&pageSize=${pageSize}` +
      `&orderBy=createdTime desc&fields=files(id,name,size,createdTime,mimeType)`,
  );
  return data.files || [];
}

/**
 * Multipart upload straight to Drive (no SDK). `appDataFolder` keeps backups invisible
 * in the normal My Drive listing.
 */
export async function driveUpload({ name, content, mime = 'application/octet-stream', appDataFolder = false } = {}) {
  if (!name || content === undefined) throw new Error('drive upload needs a name and content');
  const token = await accessToken();
  const metadata = { name, ...(appDataFolder ? { parents: ['appDataFolder'] } : {}) };
  const boundary = 'nexus' + Date.now().toString(16);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`, 'utf8'),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const res = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body,
    },
    120000,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${truncate(text, 300)}`);
  return JSON.parse(text);
}

export async function driveSearch(q, max = 10) {
  const query = q ? `name contains '${q.replace(/'/g, "\\'")}' and trashed = false` : 'trashed = false';
  const data = await api(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=${max}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink,size)`,
  );
  return data.files || [];
}

export async function driveRead(fileId, maxChars = 6000) {
  const meta = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`);
  const mime = meta.mimeType || '';
  if (mime.startsWith('application/vnd.google-apps')) {
    const exportMime = mime.includes('spreadsheet')
      ? 'text/csv'
      : mime.includes('presentation')
        ? 'text/plain'
        : 'text/plain';
    const token = await accessToken();
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    return { name: meta.name, mimeType: mime, text: truncate(text, maxChars) };
  }
  const token = await accessToken();
  const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = mime.startsWith('text/') || mime.includes('json') ? buf.toString('utf8') : `[binary ${mime}, ${buf.length} bytes]`;
  return { name: meta.name, mimeType: mime, text: truncate(text, maxChars) };
}

/* ---------------------------------- Sheets -------------------------------- */

export async function sheetsGet(spreadsheetId, range = 'A1:Z50') {
  const data = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  return { range: data.range, values: data.values || [] };
}

export async function sheetsAppend(spreadsheetId, range, values) {
  const data = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', body: { values } },
  );
  return { updated: data.updates?.updatedRows ?? 0, range: data.updates?.updatedRange };
}

export async function sheetsCreate(title) {
  const data = await api('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: { properties: { title: title || 'Nexus sheet' } },
  });
  return { id: data.spreadsheetId, url: data.spreadsheetUrl };
}

/* ---------------------------------- Docs ---------------------------------- */

export async function docsRead(documentId, maxChars = 8000) {
  const data = await api(`https://docs.googleapis.com/v1/documents/${documentId}`);
  const text = (data.body?.content || [])
    .flatMap((el) => (el.paragraph?.elements || []).map((e) => e.textRun?.content || ''))
    .join('');
  return { title: data.title, text: truncate(text, maxChars) };
}

export async function disconnect() {
  saveSettings({ google: { refreshToken: '', accessToken: '', expiry: 0, email: '' } });
  return { ok: true };
}
