import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { writeJson } from './util.js';

const FILE = path.join(DATA, 'model-credentials.json');
const sessionSecrets = new Map();
let safeStorage = null;
let secureStorageAvailable = false;

if (process.versions.electron) {
  const electron = await import('electron');
  safeStorage = electron.safeStorage;
  secureStorageAvailable = await safeStorage.isAsyncEncryptionAvailable();
}

function readStore() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the encrypted model credential store: ${error.message}`);
  }
}

export function mode() {
  if (!safeStorage) return 'session-only';
  return secureStorageAvailable ? 'os-secure' : 'unavailable';
}

export function persistentAvailable() {
  return mode() === 'os-secure';
}

export function has(id) {
  return sessionSecrets.has(id) || Boolean(readStore()[id]);
}

export function keyMode(id) {
  if (sessionSecrets.has(id)) return 'session-only';
  if (!readStore()[id]) return 'none';
  if (!safeStorage) return 'os-secure-unavailable';
  return persistentAvailable() ? 'os-secure' : 'os-secure-unavailable';
}

export function get(id) {
  if (sessionSecrets.has(id)) return sessionSecrets.get(id);
  const encrypted = readStore()[id];
  if (!encrypted) return '';
  if (!safeStorage) {
    throw new Error('This model API key uses Windows secure storage. Open the Nexus desktop app to use it.');
  }
  if (!persistentAvailable()) {
    throw new Error('Windows secure storage is unavailable; the saved model API key cannot be decrypted.');
  }
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (error) {
    throw new Error(`Could not decrypt the saved model API key: ${error.message}`);
  }
}

export function set(id, secret) {
  if (!id) throw new Error('A provider ID is required to save its model API key.');
  if (!secret) return remove(id);
  if (!safeStorage) {
    sessionSecrets.set(id, String(secret));
    return mode();
  }
  if (!persistentAvailable()) {
    throw new Error('Windows secure storage is unavailable; the API key was not saved.');
  }
  const store = readStore();
  store[id] = safeStorage.encryptString(String(secret)).toString('base64');
  writeJson(FILE, store);
  sessionSecrets.delete(id);
  return mode();
}

export function remove(id) {
  sessionSecrets.delete(id);
  const store = readStore();
  if (Object.prototype.hasOwnProperty.call(store, id)) {
    delete store[id];
    writeJson(FILE, store);
  }
}
