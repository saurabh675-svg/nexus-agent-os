import { spawn } from 'node:child_process';
import { settings, saveSettings } from './config.js';
import { TOOLS } from './tools.js';
import { truncate, log } from './util.js';

/**
 * Minimal MCP (Model Context Protocol) client over stdio JSON-RPC 2.0.
 * This is what Codex, Claude Code, AutoClaw and OpenClaw all use to plug in
 * external tool servers — so any MCP server they support works here too.
 */

const clients = new Map();
const PROTOCOL = '2024-11-05';

class StdioClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = 0;
    this.pending = new Map();
    this.alive = false;
    this.tools = [];
    this.lastError = null;
    this.stderr = '';
  }

  async start() {
    const isWin = process.platform === 'win32';
    const cmd = this.cfg.command;
    const args = this.cfg.args || [];
    this.proc = spawn(cmd, args, {
      cwd: this.cfg.cwd || process.cwd(),
      env: { ...process.env, ...(this.cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
      windowsHide: true,
    });

    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message || 'mcp error')) : p.resolve(msg.result);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    this.proc.on('exit', (code) => {
      this.alive = false;
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.cfg.name}" exited (${code})`));
      this.pending.clear();
    });
    this.proc.on('error', (e) => {
      this.lastError = e.message;
      this.alive = false;
    });

    this.alive = true;
    await this.rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        clientInfo: { name: 'nexus', version: '1.0.0' },
      },
      180000, // first run may have to download the package (uvx / npx) — do not time out early
    );
    this.notify('notifications/initialized', {});
    const listed = await this.rpc('tools/list', {});
    this.tools = listed?.tools || [];
    return this.tools;
  }

  rpc(method, params, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  async call(name, args) {
    const res = await this.rpc(
      'tools/call',
      { name, arguments: args || {} },
      120000,
    );
    const parts = (res?.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`));
    return { ok: !res?.isError, text: truncate(parts.join('\n') || JSON.stringify(res), 8000) };
  }

  stop() {
    try {
      this.proc.kill();
    } catch {}
    this.alive = false;
  }
}

function toolKey(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function registerTools(name, client, tools) {
  for (const t of tools) {
    const key = toolKey(name, t.name);
    const props = t.inputSchema?.properties || {};
    const params = Object.fromEntries(Object.keys(props).map((k) => [k, props[k]?.type || 'any']));
    TOOLS[key] = {
      desc: `[MCP ${name}] ${t.description || t.name}`,
      params,
      async run(args) {
        if (!client.alive) throw new Error(`MCP server "${name}" is not running`);
        const r = await client.call(t.name, args);
        return { ok: r.ok, server: name, tool: t.name, output: r.text };
      },
    };
  }
}

function unregisterTools(name) {
  const prefix = `mcp__${name}__`.replace(/[^a-zA-Z0-9_]/g, '_');
  for (const key of Object.keys(TOOLS)) {
    if (key.startsWith(prefix)) delete TOOLS[key];
  }
}

export async function syncServers() {
  const cfg = settings().mcp?.servers || [];
  const wanted = cfg.filter((s) => s.enabled !== false);
  const report = [];

  // stop servers that were removed or disabled
  for (const [name, client] of clients) {
    if (!wanted.find((w) => w.name === name)) {
      client.stop();
      unregisterTools(name);
      clients.delete(name);
    }
  }

  for (const s of wanted) {
    if (clients.get(s.name)?.alive) {
      report.push({ name: s.name, running: true, tools: clients.get(s.name).tools.map((t) => t.name) });
      continue;
    }
    const client = new StdioClient(s);
    try {
      const tools = await client.start();
      clients.set(s.name, client);
      unregisterTools(s.name);
      registerTools(s.name, client, tools);
      report.push({ name: s.name, running: true, tools: tools.map((t) => t.name) });
      log(`MCP "${s.name}" connected with ${tools.length} tool(s)`);
    } catch (e) {
      client.stop();
      report.push({ name: s.name, running: false, error: e.message, stderr: truncate(client.stderr, 400) });
      log(`MCP "${s.name}" failed: ${e.message}`);
    }
  }
  return report;
}

export function status() {
  const cfg = settings().mcp?.servers || [];
  return cfg.map((s) => {
    const c = clients.get(s.name);
    return {
      name: s.name,
      command: `${s.command} ${(s.args || []).join(' ')}`.trim(),
      enabled: s.enabled !== false,
      running: Boolean(c?.alive),
      tools: c?.tools?.map((t) => ({ name: t.name, description: truncate(t.description || '', 120) })) || [],
      error: c?.lastError || null,
    };
  });
}

/** Curated MCP servers that need no API key. `npx -y` fetches on first run. */
export const CATALOG = [
  { id: 'memory', label: 'Memory (knowledge graph)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], note: 'Persistent entities and relations across sessions. No key.' },
  { id: 'sequential-thinking', label: 'Sequential thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], note: 'Structured reasoning scratchpad; helps smaller models plan.' },
  { id: 'filesystem', label: 'Filesystem (scoped)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], note: 'Read/write inside one folder you pass as an argument.' },
  { id: 'git', label: 'Git', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'], note: 'Inspect repos, diffs and history. Point it at a repository.' },
  { id: 'playwright', label: 'Playwright browser (persistent Nexus Chrome)', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:${NEXUS_BROWSER_PORT}'], note: 'Official Microsoft Playwright MCP attaches to the running Nexus Chrome profile, reusing its cookies. Launch the persistent browser first; needs network on first run.' },
  { id: 'github', label: 'GitHub (official MCP, Docker OAuth)', command: 'docker', args: ['run', '-i', '--rm', '-p', '127.0.0.1:8085:8085', '-e', 'GITHUB_OAUTH_CALLBACK_PORT=8085', 'ghcr.io/github/github-mcp-server'], note: 'Official GitHub MCP server with browser-based OAuth; Docker required. No personal access token is stored by Nexus.' },
  { id: 'fetch', label: 'Fetch (HTTP)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], note: 'Fetch URL content as markdown/text.' },
  { id: 'everything', label: 'Everything (test server)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], note: 'Reference server with every feature — proves the client works.' },
];

export function catalog() {
  const installed = new Set((settings().mcp?.servers || []).map((s) => s.name));
  return CATALOG.map((c) => ({ ...c, installed: installed.has(c.id) }));
}

export async function installPreset(id, { args = [], cwd } = {}) {
  const preset = CATALOG.find((c) => c.id === id);
  if (!preset) throw new Error(`unknown preset: ${id}`);
  const browserPort = String(settings().browser?.port || 9222);
  const presetArgs = preset.args.map((arg) => arg.replaceAll('${NEXUS_BROWSER_PORT}', browserPort));
  addServer({ name: preset.id, command: preset.command, args: [...presetArgs, ...args], cwd, enabled: true });
  const report = await syncServers();
  return { preset: preset.id, report };
}

export function addServer({ name, command, args = [], cwd, env, enabled = true }) {
  if (!name || !command) throw new Error('MCP server needs a name and a command');
  const cur = (settings().mcp?.servers || []).filter((s) => s.name !== name);
  const next = [...cur, { name, command, args, cwd, env, enabled }];
  saveSettings({ mcp: { servers: next } });
  return next;
}

export function removeServer(name) {
  const next = (settings().mcp?.servers || []).filter((s) => s.name !== name);
  saveSettings({ mcp: { servers: next } });
  const c = clients.get(name);
  if (c) {
    c.stop();
    unregisterTools(name);
    clients.delete(name);
  }
  return next;
}

export function stopAll() {
  for (const [, c] of clients) c.stop();
  clients.clear();
}
