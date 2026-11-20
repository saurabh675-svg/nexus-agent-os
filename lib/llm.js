import { settings, ollamaBin } from './config.js';
import { chain as providerChain } from './providers.js';
import { fetchWithTimeout } from './util.js';

export class LLMError extends Error {}

/** Ollama Cloud models — they run on Ollama's servers, so they need no local RAM. */
export const CLOUD_SUGGESTIONS = ['gemma4:31b-cloud', 'gpt-oss:20b-cloud', 'gpt-oss:120b-cloud'];

function activeProvider() {
  const s = settings();
  if (s.provider === 'openai') {
    if (!s.openai.apiKey) {
      throw new LLMError(
        'No API key set for the OpenAI-compatible provider. Open Settings → Model and paste a key (OpenAI, Groq, DeepSeek, OpenRouter, LM Studio all work).',
      );
    }
    return {
      kind: 'openai',
      baseUrl: s.openai.baseUrl.replace(/\/$/, ''),
      key: s.openai.apiKey,
      model: s.openai.model || s.model,
    };
  }
  return { kind: 'ollama', baseUrl: s.ollamaUrl.replace(/\/$/, ''), model: s.model };
}

export function providerInfo(provider = null, modelOverride) {
  const s = settings();
  const legacy = s.provider === 'openai'
    ? { kind: 'openai', baseUrl: s.openai.baseUrl, model: s.openai.model || s.model }
    : { kind: 'ollama', baseUrl: s.ollamaUrl, model: s.model };
  const p = provider || providerChain()[0] || legacy;
  let host = 'configured endpoint'; let local = false;
  try { const url = new URL(p.baseUrl); host = url.host; local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch {}
  const model = modelOverride || p.model;
  const cloudProxy = p.kind === 'ollama' && local && /-cloud(?::[^:]*)?$/.test(model || '');
  const location = cloudProxy ? 'Ollama Cloud via local service' : local ? 'Local service' : 'Remote API';
  return { id: p.id || null, name: p.label || (p.kind === 'ollama' ? 'Ollama' : 'Compatible API'), kind: p.kind, model, host, location, label: model + ' · ' + location + (local ? '' : ' · ' + host) };
}

export function currentModelLabel() { return providerInfo().label; }

async function* ollamaStream(messages, { model, temperature, signal, provider } = {}) {
  const p = provider || activeProvider();
  let res;
  try {
    res = await fetchWithTimeout(
      `${p.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || p.model,
          messages,
          stream: true,
          options: { temperature, num_ctx: 8192 },
        }),
        signal,
      },
      600000,
    );
  } catch (e) {
    if (e?.name === 'AbortError') throw new LLMError('Run stopped.');
    throw new LLMError(
      `Cannot reach Ollama at ${p.baseUrl}. ${ollamaBin() ? 'Start it with: ollama serve' : 'Ollama binary was not found — install it from https://ollama.com/download, then run: ollama pull qwen2.5:7b'}`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new LLMError(`Ollama ${res.status}: ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new LLMError(obj.error);
      const piece = obj.message?.content;
      if (piece) yield piece;
      // Cloud models (gemma4:31b-cloud observed 2026-10-26) sometimes answer with a NATIVE Ollama
      // tool_calls array even though this app describes tools in prose only. Dropping it made the
      // model look "empty" while it was actually trying to call spawn_agent. Translate to the app's
      // fenced protocol so extractToolCall executes it like any other tool call.
      const calls = obj.message?.tool_calls;
      if (Array.isArray(calls) && calls.length) {
        for (const tc of calls) {
          const fn = tc?.function || {};
          const name = fn.name || tc?.name;
          if (!name) continue;
          let args = fn.arguments ?? tc?.arguments ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = { raw: args }; }
          }
          yield '```tool\n' + JSON.stringify({ tool: name, args }) + '\n```';
        }
      }
      if (obj.done) return;
    }
  }
}

async function* openaiStream(messages, { model, temperature, signal, provider } = {}) {
  const p = provider || activeProvider();
  if (p.credentialError) throw new LLMError(p.credentialError);
  const key = p.apiKey || p.key || '';
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(p.baseUrl).hostname); } catch {}
  if (!key && !local) throw new LLMError('No API key saved for this remote provider. Add its key in Providers while Nexus Vault is unlocked.');
  let res;
  try {
    res = await fetchWithTimeout(
      `${p.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: model || p.model, messages, stream: true, temperature }),
        signal,
      },
      600000,
    );
  } catch (e) {
    if (e?.name === 'AbortError') throw new LLMError('Run stopped.');
    throw new LLMError(`Cannot reach ${p.baseUrl}: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new LLMError(`${p.baseUrl} ${res.status}: ${body.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pendingToolCalls = new Map();
  const collectToolCalls = (calls) => {
    for (const call of calls || []) {
      const index = Number.isInteger(call.index) ? call.index : 0;
      const current = pendingToolCalls.get(index) || { name: '', arguments: '' };
      const fn = call.function || {};
      if (typeof fn.name === 'string') current.name += fn.name;
      if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
      else if (fn.arguments != null) current.arguments = JSON.stringify(fn.arguments);
      pendingToolCalls.set(index, current);
    }
  };
  const flushToolCalls = () => {
    const calls = [...pendingToolCalls.entries()].sort(([a], [b]) => a - b);
    pendingToolCalls.clear();
    return calls.map(([, call]) => {
      if (!call.name) return '';
      let args = {};
      if (call.arguments) {
        try { args = JSON.parse(call.arguments); } catch { args = { raw: call.arguments }; }
      }
      return '```tool\n' + JSON.stringify({ tool: call.name, args }) + '\n```';
    }).filter(Boolean);
  };
  const processLine = async function* (line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      for (const tool of flushToolCalls()) yield tool;
      return 'done';
    }
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.error) throw new LLMError(obj.error.message || 'provider error');
    const choice = obj.choices?.[0];
    const piece = choice?.delta?.content;
    if (piece) yield piece;
    collectToolCalls(choice?.delta?.tool_calls);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buf += dec.decode();
      break;
    }
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const lineStream = processLine(line);
      for await (const piece of lineStream) yield piece;
      if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') return;
    }
  }
  if (buf.trim()) {
    const lineStream = processLine(buf.trim());
    for await (const piece of lineStream) yield piece;
  }
  for (const tool of flushToolCalls()) yield tool;
}

export function chatStream(messages, opts = {}) {
  const temperature = opts.temperature ?? settings().temperature;
  // Try the active provider, then every other configured one. A free tier that returns 429 should
  // cost one visible line, not the whole task.
  const configured = providerChain();
  const ladder = configured.length ? configured : [null];

  return (async function* () {
    let lastError = null;
    for (let i = 0; i < ladder.length; i++) {
      const p = ladder[i];
      let started = false;
      try {
        const stream = p
          ? p.kind === 'ollama'
            ? ollamaStream(messages, { ...opts, temperature, provider: p })
            : openaiStream(messages, { ...opts, temperature, provider: p })
          : activeProvider().kind === 'openai'
            ? openaiStream(messages, { ...opts, temperature })
            : ollamaStream(messages, { ...opts, temperature });
        for await (const piece of stream) {
          if (!started) opts.onProvider?.(providerInfo(p, opts.model));
          started = true;
          yield piece;
        }
        // A 200 with zero content is a failure, not a success. Falling through here silently used to
        // surface as "The model returned an empty response" with the fallback providers never tried.
        if (!started) {
          const who = p?.label || currentModelLabel();
          if (i < ladder.length - 1) {
            yield `\n_[${who} returned an empty response — retrying on ${ladder[i + 1]?.label || 'the fallback provider'}]_\n\n`;
            continue;
          }
          throw new LLMError(`${who} returned an empty response. The model may be overloaded — try again or switch model in Providers.`);
        }
        return;
      } catch (e) {
        // A user stop must not fall through to the next provider.
        if (e?.name === 'AbortError' || (e instanceof LLMError && e.message === 'Run stopped.')) throw e;
        lastError = e;
        if (started) throw e;
        if (i < ladder.length - 1) {
          const nextLabel = ladder[i + 1]?.label || 'the fallback provider';
          yield `\n_[${p?.label || 'provider'} failed: ${String(e.message || e).slice(0, 120)} — retrying on ${nextLabel}]_\n\n`;
          continue;
        }
        throw e;
      }
    }
    throw lastError || new LLMError('no provider answered');
  })();
}

export async function complete(messages, opts = {}) {
  let out = '';
  for await (const piece of chatStream(messages, opts)) out += piece;
  return out.trim();
}

let modelCache = { at: 0, value: null, signature: '' };

export async function listModels({ fresh = false } = {}) {
  const signature = JSON.stringify(providerInfo());
  if (!fresh && modelCache.signature === signature && modelCache.value && Date.now() - modelCache.at < 30000) return modelCache.value;
  const value = await listModelsUncached();
  modelCache = { at: Date.now(), value, signature };
  return value;
}

/** Called at boot so the first page load is not waiting on a cold Ollama. */
export async function warm() {
  try {
    await listModels({ fresh: true });
  } catch {}
}

async function listModelsUncached() {
  const selected = providerChain()[0] || null;
  const s = settings();
  if (selected?.credentialError) return { provider: selected.kind, models: [], error: selected.credentialError };
  const kind = selected?.kind || (s.provider === 'openai' ? 'openai' : 'ollama');
  const baseUrl = selected?.baseUrl || (kind === 'openai' ? s.openai.baseUrl : s.ollamaUrl);
  const key = selected ? selected.apiKey || selected.key : s.openai.apiKey;
  if (kind === 'openai') {
    if (!key && !['localhost','127.0.0.1','[::1]'].includes(new URL(baseUrl).hostname)) return { provider: 'openai', models: [], error: 'no API key' };
    try {
      const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      if (!res.ok) throw new Error('Provider returned HTTP ' + res.status);
      const data = await res.json();
      return { provider: 'openai', models: (data.data || []).map((m) => m.id).sort() };
    } catch (e) {
      return { provider: 'openai', models: [], error: e.message };
    }
  }
  try {
    const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/api/tags`, {}, 4000);
    if (!res.ok) throw new Error('Ollama returned HTTP ' + res.status);
    const data = await res.json();
    const local = (data.models || []).map((m) => m.name).sort();
    return {
      provider: 'ollama',
      models: local.length ? local : CLOUD_SUGGESTIONS,
      local,
      error: null,
      note: local.length ? null : 'no local models — these are Ollama Cloud models (subscription, not on this PC)',
    };
  } catch (e) {
    return {
      provider: 'ollama',
      models: [],
      error: `Ollama unreachable at ${baseUrl}`,
      hint: ollamaBin()
        ? 'Ollama is installed — start the background service.'
        : 'Ollama binary not found on this machine.',
      binary: ollamaBin() || null,
    };
  }
}
