import fs from 'node:fs';
import path from 'node:path';
import { settings, DATA, AGENTS } from './config.js';
import * as vault from './vault.js';
import * as google from './google.js';
import * as memory from './memory.js';
import * as scheduler from './scheduler.js';
import * as skills from './skills.js';
import { writeJson, ensureDir, readJson, truncate } from './util.js';

const BACKUP_DIR = path.join(DATA, 'backups');

/** Never let a secret leave the machine inside a backup, even inside the encrypted blob. */
export function redactSettings(s) {
  const c = structuredClone(s);
  if (c.openai) c.openai.apiKey = c.openai.apiKey ? '[stored locally]' : '';
  if (c.search) {
    c.search.braveKey = c.search.braveKey ? '[stored locally]' : '';
    c.search.tavilyKey = c.search.tavilyKey ? '[stored locally]' : '';
  }
  if (c.google) {
    c.google.clientSecret = '';
    c.google.accessToken = '';
    c.google.refreshToken = '';
  }
  if (c.kaggle) c.kaggle.key = '';
  if (c.discord) c.discord.token = '';
  if (Array.isArray(c.mcp?.servers)) c.mcp.servers = c.mcp.servers.map((m) => ({ ...m, env: undefined }));
  return c;
}

export function buildBundle() {
  const s = settings();
  return {
    app: 'nexus',
    version: 1,
    generatedAt: new Date().toISOString(),
    machine: process.env.COMPUTERNAME || process.env.HOSTNAME || 'local',
    settings: redactSettings(s),
    vault: vault.exists() ? vault.exportEncrypted().payload : null,
    skills: skills.list().map((k) => {
      try {
        return { id: k.id, name: k.name, description: k.description, body: skills.load(k.id).body };
      } catch {
        return { id: k.id, name: k.name };
      }
    }),
    roles: readJson(path.join(AGENTS, 'roles.json'), {}),
    tasks: scheduler.list(),
    memory: memory.all(),
  };
}

export function listLocal() {
  try {
    ensureDir(BACKUP_DIR);
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, bytes: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

export async function runBackup({ upload = true, note = '' } = {}) {
  if (!vault.exists()) throw new Error('create the vault first — backups are encrypted with your master key');
  if (!vault.isUnlocked()) throw new Error('unlock the vault first — the backup key is derived from your master passphrase');

  const bundle = buildBundle();
  bundle.note = note;
  const sealed = vault.sealBundle(bundle);
  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `nexus-backup-${stamp}.json`;
  const file = path.join(BACKUP_DIR, name);
  writeJson(file, sealed);

  let drive = null;
  if (upload && google.isConnected()) {
    try {
      drive = await google.driveUpload({
        name,
        content: JSON.stringify(sealed),
        mime: 'application/json',
        appDataFolder: true,
      });
    } catch (e) {
      drive = { error: truncate(String(e.message || e), 300) };
    }
  }

  return {
    ok: true,
    local: { name, bytes: fs.statSync(file).size, file },
    drive,
    uploaded: Boolean(drive && !drive.error),
    counts: {
      vaultEntries: bundle.vault?.entries?.length || 0,
      skills: bundle.skills.length,
      tasks: bundle.tasks.length,
      memory: bundle.memory.length,
    },
  };
}

export async function listDriveBackups() {
  if (!google.isConnected()) return { connected: false, files: [] };
  const files = await google.driveList({ appDataFolder: true, nameContains: 'nexus-backup', pageSize: 30 });
  return { connected: true, files };
}
