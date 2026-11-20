import { settings } from './config.js';
import { log, truncate, sleep } from './util.js';

/**
 * Minimal Discord gateway bot (zero dependencies: global WebSocket + fetch).
 *
 * Two trust levels, enforced at the tool-policy layer, not by prompt wording:
 *   admin  — your DM or your admin channel: full agent, normal permission mode
 *   member — any other channel: read-only (plan mode), writes and commands are hard-denied
 */

const API = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

let ws = null;
let heartbeat = null;
let seq = null;
let running = false;
let botUser = null;
let lastError = null;
let stats = { messages: 0, replies: 0, errors: 0 };
const cooldown = new Map();

export function status() {
  const s = settings().discord || {};
  return {
    configured: Boolean(s.token),
    running,
    botUser,
    adminChannels: s.adminChannels || [],
    memberChannels: s.memberChannels || [],
    intents: INTENTS,
    lastError,
    stats,
  };
}

async function rest(pathname, options = {}) {
  const token = settings().discord?.token;
  if (!token) throw new Error('no Discord bot token configured');
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? 'token rejected — copy it again from the Developer Portal → Bot → Reset Token'
        : res.status === 403
          ? 'missing permission — check the bot role and the channel overrides'
          : '';
    throw new Error(`Discord ${res.status} ${pathname}: ${truncate(JSON.stringify(data), 200)} ${hint}`.trim());
  }
  return data;
}

export async function sendMessage(channelId, content) {
  const chunks = [];
  let rest2 = String(content || '').trim();
  if (!rest2) rest2 = '(empty)';
  while (rest2.length) {
    chunks.push(rest2.slice(0, 1900));
    rest2 = rest2.slice(1900);
  }
  let out = null;
  for (const c of chunks) {
    out = await rest(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: c }) });
  }
  stats.replies++;
  return out;
}

async function askAgent(text, { admin, channelId }) {
  const payload = {
    input: text,
    messages: [{ role: 'user', content: text }],
    mode: 'agent',
    role: admin ? 'core' : 'researcher',
    policyMode: admin ? undefined : 'plan',
  };
  const res = await fetch('http://127.0.0.1:8787/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.body) throw new Error(`local agent returned ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let answer = '';
  let error = '';
  const tools = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev === 'answer') answer = d.text || answer;
      else if (ev === 'tool_end') tools.push(`${d.name}${d.ok ? '✓' : '✗'}`);
      else if (ev === 'error') error = d.message;
      else if (ev === 'approval') {
        sendMessage(
          channelId,
          `⚠ needs your approval: **${d.tool}** — \`${truncate(d.summary, 120)}\`\nApprove in the Nexus desktop app (Safety panel), or reply \`!approve\`.`,
        ).catch(() => {});
      }
    }
  }
  if (error) throw new Error(error);
  const footer = tools.length ? `\n\n_${tools.slice(0, 6).join(' · ')}_` : '';
  return (answer || '(no answer)') + footer;
}

async function handleMessage(msg) {
  if (!msg || !msg.content) return;
  if (msg.author?.bot) return;
  stats.messages++;

  const s = settings().discord || {};
  const isDM = !msg.guild_id;
  const isAdminChannel = (s.adminChannels || []).includes(msg.channel_id);
  const isMemberChannel = (s.memberChannels || []).includes(msg.channel_id) || Array.isArray(s.memberChannels) === false;
  const admin = isDM || isAdminChannel;

  const content = String(msg.content).trim();
  if (!content) return;
  if (content === '!ping') return sendMessage(msg.channel_id, 'online · policy ' + settings().policy.mode);
  if (content === '!pending') {
    const r = await fetch('http://127.0.0.1:8787/api/approvals').then((x) => x.json()).catch(() => ({ pending: [] }));
    const list = r.pending || [];
    return sendMessage(
      msg.channel_id,
      list.length ? list.map((p, i) => `${i + 1}. **${p.tool}** — \`${truncate(p.summary, 100)}\``).join('\n') : 'nothing waiting for approval',
    );
  }
  if (/^!(approve|deny)\b/i.test(content)) {
    const decision = content.toLowerCase().startsWith('!approve') ? 'allow' : 'deny';
    const r = await fetch('http://127.0.0.1:8787/api/approvals').then((x) => x.json()).catch(() => ({ pending: [] }));
    const first = (r.pending || [])[0];
    if (!first) return sendMessage(msg.channel_id, 'no pending approvals');
    const out = await fetch('http://127.0.0.1:8787/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: first.id, decision, scope: 'once' }),
    }).then((x) => x.json());
    return sendMessage(msg.channel_id, out.ok ? `${decision === 'allow' ? '✓ approved' : '✕ denied'} ${first.tool}` : `failed: ${out.error}`);
  }
  if (content.startsWith('!')) {
    return sendMessage(msg.channel_id, 'commands: `!ping` `!pending` `!approve` `!deny` — anything else is a task.');
  }

  // rate limit per channel
  const last = cooldown.get(msg.channel_id) || 0;
  if (Date.now() - last < 1500) return;
  cooldown.set(msg.channel_id, Date.now());

  if (!admin) {
    const guard = `You are replying inside a public community channel. Be brief (under 1200 characters), factual, and cite sources. You cannot run commands or change files in this mode.`;
    try {
      const reply = await askAgent(`${guard}\n\nMember question: ${content}`, { admin: false, channelId: msg.channel_id });
      return sendMessage(msg.channel_id, truncate(reply, 1800));
    } catch (e) {
      stats.errors++;
      return sendMessage(msg.channel_id, `could not answer: ${truncate(String(e.message), 300)}`);
    }
  }

  try {
    await rest(`/channels/${msg.channel_id}/typing`, { method: 'POST' }).catch(() => {});
    const reply = await askAgent(content, { admin: true, channelId: msg.channel_id });
    return sendMessage(msg.channel_id, truncate(reply, 3800));
  } catch (e) {
    stats.errors++;
    return sendMessage(msg.channel_id, `error: ${truncate(String(e.message), 400)}`);
  }
}

function startHeartbeat(interval) {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    try {
      ws?.send(JSON.stringify({ op: 1, d: seq }));
    } catch {}
  }, interval);
  heartbeat.unref?.();
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

export async function start() {
  const s = settings().discord || {};
  if (!s.token) throw new Error('Add a bot token first (Discord Developer Portal → Bot → Reset Token).');
  if (running) return status();
  lastError = null;

  const gw = await rest('/gateway/bot');
  const url = `${gw.url}/?v=10&encoding=json`;

  await new Promise((resolve, reject) => {
    let settled = false;
    ws = new WebSocket(url);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      running = false;
      lastError = String(e?.message || e);
      try {
        ws?.close();
      } catch {}
      reject(new Error(lastError));
    };

    ws.addEventListener('open', () => log('discord gateway open'));
    ws.addEventListener('error', () => fail(new Error('gateway socket error — check the token and network')));

    ws.addEventListener('message', async (ev) => {
      let pkt;
      try {
        pkt = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (pkt.s !== null && pkt.s !== undefined) seq = pkt.s;

      if (pkt.op === 10) {
        startHeartbeat(pkt.d.heartbeat_interval);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token: s.token,
              intents: INTENTS,
              properties: { os: process.platform, browser: 'nexus', device: 'nexus' },
              presence: { status: 'online', activities: [{ name: 'Nexus · local agent', type: 0 }] },
            },
          }),
        );
      } else if (pkt.op === 11) {
        // heartbeat ack
      } else if (pkt.op === 7) {
        ws.close();
      } else if (pkt.op === 9) {
        fail(new Error('invalid session — token or intents rejected (enable MESSAGE CONTENT INTENT)'));
      } else if (pkt.op === 0) {
        if (pkt.t === 'READY') {
          botUser = { id: pkt.d.user.id, username: pkt.d.user.username };
          running = true;
          if (!settled) {
            settled = true;
            resolve();
          }
          log(`discord bot ready as ${botUser.username}#${pkt.d.user.discriminator ?? ''}`);
        } else if (pkt.t === 'MESSAGE_CREATE') {
          handleMessage(pkt.d).catch((e) => {
            stats.errors++;
            log('discord message error', e.message);
          });
        }
      }
    });

    ws.addEventListener('close', (ev) => {
      running = false;
      stopHeartbeat();
      if (!settled) return fail(new Error(`gateway closed (${ev.code})`));
      if (ev.code !== 1000) log(`discord gateway closed (${ev.code}) — reconnect manually`);
    });

    setTimeout(() => fail(new Error('gateway timeout after 20s')), 20000);
  });

  return status();
}

export async function stop() {
  stopHeartbeat();
  try {
    ws?.close(1000);
  } catch {}
  ws = null;
  running = false;
  await sleep(150);
  return status();
}

export async function test() {
  const me = await rest('/users/@me');
  return { ok: true, username: me.username, id: me.id, bot: me.bot };
}
