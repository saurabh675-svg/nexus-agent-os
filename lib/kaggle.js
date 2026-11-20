import fs from 'node:fs';
import path from 'node:path';
import { settings } from './config.js';
import { fetchWithTimeout, readJson, truncate } from './util.js';

const BASE = 'https://www.kaggle.com/api/v1';

function authHeader() {
  const k = settings().kaggle;
  if (!k.username || !k.key) {
    throw new Error(
      'Kaggle credentials missing. Settings → Kaggle: paste your username and API key from https://www.kaggle.com/settings/account (Create New Token).',
    );
  }
  return 'Basic ' + Buffer.from(`${k.username}:${k.key}`).toString('base64');
}

async function call(pathname, { method = 'GET', body, json = true, raw = false } = {}) {
  const res = await fetchWithTimeout(`${BASE}${pathname}`, {
    method,
    headers: { authorization: authHeader(), accept: json ? 'application/json' : '*/*' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kaggle ${res.status} on ${pathname.split('?')[0]}: ${truncate(text, 300)}`);
  }
  if (raw) return res;
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: truncate(text, 2000) };
  }
}

export function isConfigured() {
  const k = settings().kaggle;
  return Boolean(k.username && k.key);
}

/** Write canonical ~/.kaggle/kaggle.json so the kaggle CLI and python libs also work. */
export function writeKaggleJson() {
  const k = settings().kaggle;
  if (!isConfigured()) return false;
  const dir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kaggle');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kaggle.json');
  fs.writeFileSync(file, JSON.stringify({ username: k.username, key: k.key }, null, 2), 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

export async function listKernels({ search = '', user = '', page = 1, pageSize = 20 } = {}) {
  const q = new URLSearchParams();
  if (user || settings().kaggle.username) q.set('user', user || settings().kaggle.username);
  if (search) q.set('search', search);
  q.set('page', page);
  q.set('pageSize', pageSize);
  const data = await call(`/kernels/list?${q}`);
  return (Array.isArray(data) ? data : []).map((k) => ({
    ref: k.ref,
    title: k.title,
    lastRun: k.lastRunTime,
    status: k.status || '',
    votes: k.totalVotes,
    language: k.language,
    url: `https://www.kaggle.com/code/${k.ref}`,
  }));
}

export async function kernelStatus(ref) {
  const data = await call(`/kernels/status?ref=${encodeURIComponent(ref)}`);
  return { ref, status: data.status || 'unknown', raw: data };
}

export async function kernelOutput(ref) {
  const data = await call(`/kernels/output?ref=${encodeURIComponent(ref)}`);
  const files = (data.files || []).map((f) => ({ name: f.name || f.ref, size: f.totalBytes || f.size, ref: f.ref }));
  return { ref, files };
}

export async function kernelLog(ref) {
  const res = await call(`/kernels/output/${ref}`, { raw: true });
  return truncate(await res.text(), 8000);
}

/** Push (or re-run) a kernel from a local folder containing kernel-metadata.json. */
export async function pushKernel(dir) {
  const abs = path.resolve(dir);
  const metaFile = path.join(abs, 'kernel-metadata.json');
  if (!fs.existsSync(metaFile)) throw new Error(`No kernel-metadata.json in ${abs}`);
  const meta = readJson(metaFile, {});
  const idParts = String(meta.id || '').split('/');
  const userName = idParts[0] || settings().kaggle.username;
  const slug = idParts[1] || path.basename(abs);

  const form = new FormData();
  const files = (meta.code_file ? [meta.code_file] : fs.readdirSync(abs).filter((f) => !f.endsWith('.json') || f === 'kernel-metadata.json'));
  for (const f of files) {
    const p = path.join(abs, path.basename(f));
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    form.append('files', new Blob([fs.readFileSync(p)]), path.basename(f));
  }
  form.append('files', new Blob([fs.readFileSync(metaFile)]), 'kernel-metadata.json');

  const res = await fetchWithTimeout(
    `${BASE}/kernels/push?userName=${encodeURIComponent(userName)}&slug=${encodeURIComponent(slug)}`,
    { method: 'POST', headers: { authorization: authHeader() }, body: form },
    120000,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Kaggle push ${res.status}: ${truncate(text, 400)}`);
  return { ref: `${userName}/${slug}`, response: truncate(text, 600) };
}

export async function listCompetitions({ search = '', pageSize = 10 } = {}) {
  const q = new URLSearchParams({ sortBy: 'latestDeadline', page: 1, pageSize });
  const data = await call(`/competitions/list?${q}`);
  return (Array.isArray(data) ? data : [])
    .filter((c) => !search || `${c.title} ${c.ref}`.toLowerCase().includes(String(search).toLowerCase()))
    .map((c) => ({
      ref: c.ref,
      title: c.title,
      deadline: c.deadline,
      category: c.category,
      prize: c.reward,
      url: `https://www.kaggle.com/c/${c.ref}`,
    }));
}

export async function listDatasets({ search = '', pageSize = 10 } = {}) {
  const q = new URLSearchParams({ search, page: 1, pageSize, sortBy: 'hottest' });
  const data = await call(`/datasets/list?${q}`);
  return (Array.isArray(data) ? data : []).map((d) => ({
    ref: d.ref,
    title: d.title,
    size: d.totalBytes,
    downloads: d.downloadCount,
    url: `https://www.kaggle.com/datasets/${d.ref}`,
  }));
}

export async function whoAmI() {
  try {
    const data = await call('/kernels/list?page=1&pageSize=1');
    return { ok: true, username: settings().kaggle.username, kernels: Array.isArray(data) ? data.length : 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
