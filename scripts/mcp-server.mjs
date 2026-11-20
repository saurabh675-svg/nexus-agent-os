#!/usr/bin/env node
/**
 * Nexus as an MCP server.
 *
 * Exposes a *read-only* slice of Nexus to other agents (Codex, Claude Code, anything that speaks
 * MCP) over stdio JSON-RPC. It is a thin proxy to the running app on 127.0.0.1, so there is exactly
 * one implementation of each tool and one policy gate.
 *
 * Deliberately NOT exposed: shell, file writes, browser clicking. Another agent should not be able to
 * drive your machine through your agent — read tools only.
 *
 * Add to Claude Code / Codex:
 *   { "mcpServers": { "nexus": { "command": "node", "args": ["C:\\Nexus\\scripts\\mcp-server.mjs"] } } }
 */

const BASE = process.env.NEXUS_URL || 'http://127.0.0.1:8787';

const TOOLS = [
  {
    name: 'nexus_web_search',
    description: 'Search the live web. Returns titles, URLs and snippets.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] },
    call: async (a) => http('/api/search', { q: a.query, max: a.max || 6 }),
  },
  {
    name: 'nexus_open_page',
    description: 'Fetch one URL and return its readable text.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    call: async (a) => http('/api/page', { url: a.url }),
  },
  {
    name: 'nexus_search_pc',
    description: "Search the user's own PC index for files by name or path.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    call: async (a) => http('/api/index', { action: 'search', q: a.query, limit: a.limit || 30 }),
  },
  {
    name: 'nexus_read_file',
    description: 'Read a text file from the workspace or project folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    call: async (a) => http('/api/fs/read', { path: a.path }),
  },
  {
    name: 'nexus_brain_search',
    description: "Search the user's long-term brain (projects, decisions, deadlines, preferences).",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    call: async (a) => http('/api/brain?q=' + encodeURIComponent(a.query)),
  },
  {
    name: 'nexus_jobs',
    description: 'List background jobs and their status/percent.',
    inputSchema: { type: 'object', properties: {} },
    call: async () => http('/api/jobs', undefined, 'GET'),
  },
  {
    name: 'nexus_preview',
    description: 'Preview a file (pptx/docx/pdf/image/text) — text plus slide count and thumbnails.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    call: async (a) => http('/api/preview?path=' + encodeURIComponent(a.path), undefined, 'GET'),
  },
];

async function http(pathname, body, method) {
  const res = await fetch(BASE + pathname, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nexus', version: '1.0.0' },
      },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unknown tool: ${params?.name}` }] } });
    }
    try {
      const out = await tool.call(params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out).slice(0, 20000) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

let buf = '';
let pending = 0;
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    pending++;
    try {
      handle(JSON.parse(line)).finally(() => {
        pending--;
      });
    } catch {
      pending--;
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
  }
});
// Give in-flight tool calls a moment to answer before the client closes the pipe.
process.stdin.on('end', () => {
  const iv = setInterval(() => {
    if (pending <= 0) {
      clearInterval(iv);
      process.exit(0);
    }
  }, 50);
  setTimeout(() => process.exit(0), 4000);
});
