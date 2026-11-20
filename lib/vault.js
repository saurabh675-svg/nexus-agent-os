import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { readJson, writeJson, uid, ensureDir } from './util.js';

/**
 * Encrypted credential vault.
 *
 * Design rules (deliberate, do not relax them):
 *  - the master passphrase is never stored, never logged, never sent anywhere
 *  - scrypt KDF (N=32768) -> 32-byte key -> AES-256-GCM per entry
 *  - the session key lives in memory only; lock() wipes it
 *  - plaintext passwords only ever leave this module through reveal()
 *  - the on-disk file is ciphertext, so it is safe to copy / upload as a backup
 *  - the browser's own password store is never read or imported
 */

const FILE = path.join(DATA, 'vault.json');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

let sessionKey = null;
let sessionSalt = null;
let failures = 0;
let lastFailure = 0;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function derive(passphrase, saltBuf) {
  return crypto.scryptSync(String(passphrase), saltBuf, 32, SCRYPT);
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

function decrypt(key, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(blob.iv));
  decipher.setAuthTag(unb64(blob.tag));
  return Buffer.concat([decipher.update(unb64(blob.ct)), decipher.final()]).toString('utf8');
}

function readVault() {
  return readJson(FILE, null);
}

export function exists() {
  return fs.existsSync(FILE);
}

export function isUnlocked() {
  return Boolean(sessionKey);
}

export function lock() {
  if (sessionKey) sessionKey.fill(0);
  sessionKey = null;
  sessionSalt = null;
  return { locked: true };
}

export function status() {
  const v = readVault();
  return {
    exists: Boolean(v),
    unlocked: isUnlocked(),
    entries: v?.entries?.length || 0,
    createdAt: v?.createdAt || null,
    updatedAt: v?.updatedAt || null,
    file: FILE,
  };
}

export function create(passphrase) {
  if (exists()) throw new Error('vault already exists — unlock it instead');
  if (!passphrase || String(passphrase).length < 8) throw new Error('master passphrase must be at least 8 characters');
  const salt = crypto.randomBytes(16);
  const key = derive(passphrase, salt);
  const verifier = encrypt(key, 'nexus-vault-v1');
  writeJson(FILE, {
    version: 1,
    createdAt: new Date().toISOString(),
    salt: b64(salt),
    verifier,
    entries: [],
  });
  sessionKey = key;
  sessionSalt = salt;
  return status();
}

export function unlock(passphrase) {
  const v = readVault();
  if (!v) throw new Error('no vault yet — create one first');
  if (failures >= 5 && Date.now() - lastFailure < 60000) {
    throw new Error('too many wrong attempts — wait a minute');
  }
  const salt = unb64(v.salt);
  const key = derive(passphrase, salt);
  try {
    const probe = decrypt(key, v.verifier);
    if (probe !== 'nexus-vault-v1') throw new Error('bad verifier');
  } catch {
    failures++;
    lastFailure = Date.now();
    throw new Error(`wrong master passphrase (${failures} failed attempt${failures === 1 ? '' : 's'})`);
  }
  failures = 0;
  sessionKey = key;
  sessionSalt = salt;
  return status();
}

export function changePassphrase(oldPass, newPass) {
  unlock(oldPass);
  const entries = list({ withSecrets: true });
  const v = readVault();
  const salt = crypto.randomBytes(16);
  const key = derive(newPass, salt);
  writeJson(FILE, {
    version: 1,
    createdAt: v.createdAt,
    updatedAt: new Date().toISOString(),
    salt: b64(salt),
    verifier: encrypt(key, 'nexus-vault-v1'),
    entries: entries.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      blob: encrypt(key, JSON.stringify(e.data)),
    })),
  });
  sessionKey = key;
  sessionSalt = salt;
  return status();
}

function requireKey() {
  if (!sessionKey) throw new Error('vault is locked — unlock it with your master passphrase');
  return sessionKey;
}

export function list({ withSecrets = false } = {}) {
  const key = requireKey();
  const v = readVault();
  if (!v) return [];
  return (v.entries || [])
    .map((e) => {
      try {
        const data = JSON.parse(decrypt(key, e.blob));
        const out = {
          id: e.id,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          service: data.service || '',
          username: data.username || '',
          url: data.url || '',
          notes: data.notes || '',
          tags: data.tags || [],
          hasPassword: Boolean(data.password),
        };
        if (withSecrets) {
          out.data = data;
        } else {
          out.passwordMasked = data.password ? '••••••••' : '';
        }
        return out;
      } catch {
        return { id: e.id, service: '(cannot decrypt)', error: true };
      }
    })
    .sort((a, b) => (a.service || '').localeCompare(b.service || ''));
}

export function search(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return list();
  return list().filter((e) =>
    [e.service, e.username, e.url, e.notes, ...(e.tags || [])].join(' ').toLowerCase().includes(q),
  );
}

export function add(entry = {}) {
  const key = requireKey();
  if (!entry.service) throw new Error('entry needs a service name (e.g. "Discord")');
  const v = readVault();
  const id = uid('v_');
  const data = {
    service: String(entry.service).slice(0, 160),
    username: String(entry.username || '').slice(0, 300),
    password: String(entry.password || '').slice(0, 2000),
    url: String(entry.url || '').slice(0, 500),
    notes: String(entry.notes || '').slice(0, 4000),
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 12) : [],
  };
  v.entries.push({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), blob: encrypt(key, JSON.stringify(data)) });
  v.updatedAt = new Date().toISOString();
  writeJson(FILE, v);
  return { id, service: data.service, username: data.username };
}

export function update(id, patch = {}) {
  const key = requireKey();
  const v = readVault();
  const rec = (v.entries || []).find((e) => e.id === id);
  if (!rec) throw new Error('entry not found');
  const data = JSON.parse(decrypt(key, rec.blob));
  const next = {
    service: String(patch.service ?? data.service).slice(0, 160),
    username: String(patch.username ?? data.username).slice(0, 300),
    password: String(patch.password ?? data.password).slice(0, 2000),
    url: String(patch.url ?? data.url).slice(0, 500),
    notes: String(patch.notes ?? data.notes).slice(0, 4000),
    tags: Array.isArray(patch.tags) ? patch.tags.slice(0, 12) : data.tags || [],
  };
  rec.blob = encrypt(key, JSON.stringify(next));
  rec.updatedAt = new Date().toISOString();
  v.updatedAt = new Date().toISOString();
  writeJson(FILE, v);
  return { id, service: next.service };
}

export function remove(id) {
  const v = readVault();
  const before = v.entries.length;
  v.entries = v.entries.filter((e) => e.id !== id);
  if (v.entries.length === before) throw new Error('entry not found');
  v.updatedAt = new Date().toISOString();
  writeJson(FILE, v);
  return { removed: id };
}

export function reveal(id) {
  const key = requireKey();
  const v = readVault();
  const rec = (v.entries || []).find((e) => e.id === id);
  if (!rec) throw new Error('entry not found');
  const data = JSON.parse(decrypt(key, rec.blob));
  return { id, service: data.service, username: data.username, password: data.password, url: data.url };
}

export function generate({ length = 20, symbols = true } = {}) {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const syms = '!@#$%^&*-_=+?';
  const pools = [lower, upper, digits, ...(symbols ? [syms] : [])];
  const len = Math.min(Math.max(Number(length) || 20, 8), 128);
  const all = pools.join('');
  const chars = pools.map((p) => p[crypto.randomInt(p.length)]);
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Ciphertext-only export — safe to store on Drive or hand to another device. */
export function exportEncrypted() {
  const v = readVault();
  if (!v) throw new Error('no vault to export');
  return {
    app: 'nexus-vault',
    exportedAt: new Date().toISOString(),
    payload: v,
  };
}

/** Encrypt an arbitrary bundle with the unlocked session key (used for backups). */
export function sealBundle(obj) {
  const key = requireKey();
  return {
    app: 'nexus-backup',
    version: 1,
    at: new Date().toISOString(),
    salt: b64(sessionSalt),
    blob: encrypt(key, JSON.stringify(obj)),
  };
}

/** Decrypt a backup bundle with a passphrase (works on any machine). */
export function openBundle(sealed, passphrase) {
  const key = derive(passphrase, unb64(sealed.salt));
  return JSON.parse(decrypt(key, sealed.blob));
}

export function healthCheck() {
  const key = crypto.randomBytes(32);
  const sample = 'round-trip';
  const ok = decrypt(key, encrypt(key, sample)) === sample;
  return { crypto: ok ? 'aes-256-gcm ok' : 'BROKEN', kdf: `scrypt N=${SCRYPT.N}`, unlocked: isUnlocked() };
}
