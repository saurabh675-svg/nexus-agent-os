/**
 * Thin plugin loader (6.8) — pure ESM, zero npm deps.
 * Scans data/plugins/<id>/plugin.json and activates modules that export activate(api).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, WORKSPACE, settings, publicSettings } from './config.js';
import { ensureDir, log } from './util.js';
import { TOOLS } from './tools.js';
import * as eventbus from './eventbus.js';

const DIR = path.join(DATA, 'plugins');
const deactivators = new Map();

function listManifests() {
  ensureDir(DIR);
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    const manifest = path.join(DIR, name, 'plugin.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      out.push({
        id: raw.id || name,
        name: raw.name || name,
        version: raw.version || '0.0.0',
        description: raw.description || '',
        main: raw.main || 'index.js',
        permissions: raw.permissions || [],
        dir: path.join(DIR, name),
        enabled: true,
      });
    } catch (e) {
      log('plugin manifest error', name, e.message);
    }
  }
  return out;
}

function makeApi(pluginId) {
  return {
    workspace: WORKSPACE,
    config: publicSettings(),
    registerTool(name, def) {
      const key = `plugin__${pluginId}__${String(name).replace(/[^a-zA-Z0-9_]/g, '_')}`;
      if (!def?.run) throw new Error('tool needs run()');
      TOOLS[key] = {
        desc: `[plugin:${pluginId}] ${def.desc || name}`,
        params: def.params || {},
        run: def.run,
      };
      log(`plugin tool registered: ${key}`);
      return key;
    },
    emit: (type, payload, opts) => eventbus.emit(type, payload, { ...opts, source: `plugin:${pluginId}` }),
    on: (fn) => eventbus.on(fn),
  };
}

export async function loadAll() {
  const enabled = new Set(settings().plugins?.enabledIds || null);
  const manifests = listManifests();
  const loaded = [];
  for (const m of manifests) {
    if (enabled.size && !enabled.has(m.id)) {
      m.enabled = false;
      loaded.push(m);
      continue;
    }
    try {
      const entry = path.join(m.dir, m.main);
      if (!fs.existsSync(entry)) throw new Error(`missing ${m.main}`);
      const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`);
      if (typeof mod.activate !== 'function') throw new Error('no activate() export');
      const api = makeApi(m.id);
      const deactivate = await mod.activate(api);
      if (typeof deactivate === 'function') deactivators.set(m.id, deactivate);
      m.enabled = true;
      m.loaded = true;
      loaded.push(m);
      log(`plugin loaded: ${m.id}@${m.version}`);
    } catch (e) {
      m.enabled = false;
      m.loaded = false;
      m.error = String(e.message || e);
      loaded.push(m);
      log(`plugin failed: ${m.id}`, m.error);
    }
  }
  return loaded;
}

export function list() {
  return listManifests();
}

export async function reload() {
  for (const [id, fn] of deactivators) {
    try {
      await fn();
    } catch {}
    deactivators.delete(id);
  }
  // drop previous plugin tools
  for (const k of Object.keys(TOOLS)) {
    if (k.startsWith('plugin__')) delete TOOLS[k];
  }
  return loadAll();
}
