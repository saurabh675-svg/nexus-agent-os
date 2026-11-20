import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, ensureDir } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const SHOTS = path.join(DATA, 'shots');
export const WORKSPACE = path.join(DATA, 'workspace');
export const SKILLS = path.join(ROOT, 'skills');
export const AGENTS = path.join(ROOT, 'agents');
export const PUBLIC = path.join(ROOT, 'public');
export const SETTINGS_FILE = path.join(DATA, 'settings.json');
export const PORT = Number(process.env.PORT || 8787);
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;

for (const d of [DATA, SHOTS, WORKSPACE, SKILLS, AGENTS, PUBLIC]) ensureDir(d);

export const DEFAULTS = {
  provider: 'ollama', // 'ollama' | 'openai'
  model: 'qwen2.5:7b',
  temperature: 0.4,
  maxSteps: 14,
  ollamaUrl: 'http://127.0.0.1:11434',
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
  search: {
    provider: 'ddg', // ddg | searx | brave | tavily
    searxUrl: 'https://searx.be',
    braveKey: '',
    tavilyKey: '',
    maxResults: 6,
  },
  google: {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    accessToken: '',
    expiry: 0,
    email: '',
    accounts: [],
    activeId: '',
    pendingLabel: '',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/documents',
    ],
  },
  kaggle: { username: '', key: '', defaultKernel: '' },
  github: { token: '', defaultRepo: '' },
  shell: { enabled: true, timeoutMs: 120000 },
  browser: { engine: 'auto', /* auto | builtin | cdp */ port: 9222, profileDir: path.join(DATA, 'chrome-profile'), headless: false, lastUrl: '' },
  enabledSkills: [],
  policy: {
    mode: 'ask',
    rules: [],
    approveTimeoutSec: 180,
    checkpoint: true,
    maxStepsPerRun: 20,
    maxToolCallsPerRun: 30,
    runWallClockSec: 900,
  },
  mcp: { servers: [] },
  providers: [],
  activeProviderId: '',
  hooks: { enabled: true, preTool: [], postTool: [] },
  notify: { discordChannelId: '', onTaskEnd: true },
  commands: [],
  updateUrl: '',
  plugins: { enabledIds: [] },  // empty = load all discovered plugins
  routing: { cheapModel: '', strongModel: '', enabled: true },

  discord: { token: '', adminChannels: [], memberChannels: [], brand: '' },
  telegram: { token: '', chatId: '' },
  agent: { name: 'Nexus', role: 'a general-purpose local agent', user: '' },
  ui: { theme: 'aurora', density: 'comfortable', accent: 'mint', wallpaper: 'aurora' },
};

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

let cache = null;

function migrate(s) {
  // Scopes were widened for encrypted Drive backups; reconnect once to grant them.
  const needed = 'https://www.googleapis.com/auth/drive.appdata';
  if (s.google && Array.isArray(s.google.scopes) && !s.google.scopes.includes(needed)) {
    s.google.scopes = [...DEFAULTS.google.scopes];
  }
  return s;
}

export function settings() {
  if (!cache) {
    const disk = readJson(SETTINGS_FILE, {});
    cache = migrate(deepMerge(structuredClone(DEFAULTS), disk));
  }
  return cache;
}

export function saveSettings(patch) {
  cache = deepMerge(settings(), patch);
  writeJson(SETTINGS_FILE, cache);
  return cache;
}

/** Strip secrets before sending settings to the browser. */
export function publicSettings() {
  const s = structuredClone(settings());
  const mask = (v) => (v ? '••••' + String(v).slice(-4) : '');
  s.openai.apiKey = mask(s.openai.apiKey);
  if (Array.isArray(s.providers)) s.providers = s.providers.map(p => ({ ...p, apiKey: mask(p.apiKey), ...(p.key ? { key: mask(p.key) } : {}) }));
  s.search.braveKey = mask(s.search.braveKey);
  s.search.tavilyKey = mask(s.search.tavilyKey);
  s.google.clientSecret = mask(s.google.clientSecret);
  s.google.refreshToken = mask(s.google.refreshToken);
  s.google.accessToken = '';
  s.google.pendingLabel = '';
  if (Array.isArray(s.google.accounts)) s.google.accounts = s.google.accounts.map((a) => ({ id: a.id, label: a.label, email: a.email }));
  s.kaggle.key = mask(s.kaggle.key);
  s.discord.token = mask(s.discord.token);
  s.github.token = mask(s.github.token);
  s.telegram.token = mask(s.telegram.token);
  return s;
}

/** After a masked value comes back from the UI, keep the stored secret instead of overwriting it. */
export function unmaskSettings(patch) {
  const cur = settings();
  const fix = (next, prev) => {
    if (next && typeof next === 'object') {
      for (const k of Object.keys(next)) {
        if (typeof next[k] === 'string' && next[k].startsWith('••••')) next[k] = prev?.[k] ?? '';
        else if (next[k] && typeof next[k] === 'object') fix(next[k], prev?.[k]);
      }
    }
  };
  fix(patch, cur);
  return patch;
}

export function ollamaBin() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
  const candidates = [
    process.env.OLLAMA_EXE,
    local ? path.join(local, 'Programs', 'Ollama', 'ollama.exe') : null,
    local ? path.join(local, 'Ollama', 'ollama.exe') : null,
    'C:\\Program Files\\Ollama\\ollama.exe',
    'C:\\Program Files (x86)\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export function chromeBin() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
    // Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    // Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Brave
    local ? path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    // Chromium / Linux / Mac
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export const PLATFORM = {
  os: process.platform,
  shell: process.platform === 'win32' ? 'powershell' : 'bash',
  home: process.env.USERPROFILE || process.env.HOME || '',
};
