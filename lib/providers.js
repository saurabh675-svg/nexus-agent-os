import { settings, saveSettings } from './config.js';
import { fetchWithTimeout, uid, truncate } from './util.js';
import * as vault from './vault.js';
import * as modelSecrets from './model-secrets.js';

/**
 * Provider profiles.
 *
 * One active provider is fragile: free tiers rate-limit (429), keys get revoked, a gateway has an
 * outage. So we store several profiles and try them in order — first that answers wins, and the user
 * is told which one actually served the reply.
 *
 * Everything here speaks either the Ollama API or the OpenAI-compatible dialect, which covers
 * OpenRouter, Groq, DeepSeek, Together, Cerebras, Gemini's compatibility endpoint and LM Studio.
 */

export const PRESETS = [
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud (local Ollama sign-in)',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'gemma4:31b-cloud',
    needsKey: false,
    note: 'Uses your signed-in local Ollama service to reach hosted models. Cloud models are not local inference; account limits and pricing apply.',
  },
  {
    id: 'ollama-cloud-api',
    label: 'Ollama Cloud API',
    kind: 'openai',
    baseUrl: 'https://ollama.com/v1',
    model: 'gemma4:31b',
    needsKey: true,
    keyUrl: 'https://ollama.com/settings/keys',
    note: 'Direct OpenAI-compatible Cloud API. Requires an Ollama API key and a model available to your account.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Use “find free models” to pick a currently listed free model. Limits and listings vary by account and model.',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Check the current account and model limits; availability and pricing can change.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Very cheap, strong at code. Paid but small spend.',
  },
  {
    id: 'together',
    label: 'Together',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    needsKey: true,
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    note: 'Open-weight models, free tier on some.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai',
    note: 'Fastest tokens/sec of the free tiers.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    supportsVision: true,
    note: 'Choose a currently available model from the provider catalogue. Free API quota varies; do not send sensitive data to unpaid services.',
  },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    needsKey: true,
    keyUrl: 'https://build.nvidia.com',
    note: 'OpenAI-compatible hosted NIM endpoint. Choose a model enabled for your NVIDIA account; trial availability and limits vary.',
  },
  {
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    kind: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    model: '',
    needsKey: true,
    keyUrl: 'https://vercel.com/dashboard',
    note: 'OpenAI-compatible gateway. Use the model catalogue to choose a model; free credits and model eligibility vary.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    needsKey: false,
    note: 'Anything you loaded locally. No key needed.',
  },
];

export function profiles() {
  migrateInlineKeysToSecureStorage();
  const s = settings();
  return Array.isArray(s.providers) ? s.providers : [];
}

function migrateInlineKeysToSecureStorage() {
  if (!modelSecrets.persistentAvailable()) return;
  const s = settings();
  const list = (Array.isArray(s.providers) ? s.providers : []).map((p) => ({ ...p }));
  let changed = false;
  for (const profile of list) {
    const key = profile.apiKey || profile.key;
    if (!key || String(key).startsWith('••••')) continue;
    modelSecrets.set(profile.id, key);
    delete profile.apiKey;
    delete profile.key;
    changed = true;
  }
  const legacyKey = s.openai?.apiKey;
  if (legacyKey) {
    modelSecrets.set('legacy-openai', legacyKey);
    changed = true;
  }
  if (changed) {
    saveSettings({ providers: list, openai: { apiKey: '' } });
  }
}

export function activeId() {
  return settings().activeProviderId || '';
}

export function activeProfile() {
  const id = activeId();
  return profiles().find((p) => p.id === id) || null;
}

/** Ordered list: active first, then every other usable profile. */
export function chain() {
  const all = profiles().filter((p) => p.baseUrl && p.model);
  const active = activeProfile();
  const rest = all.filter((p) => p.id !== active?.id).sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const legacy = all.length ? null : legacyProfile();
  const primary = active || rest[0] || legacy;
  const routing = settings().routing || {};
  const allowRemote = routing.allowRemoteFallback === true;
  const allowLocal = routing.localFallbackEnabled === true;
  const candidates = !primary
    ? []
    : [
      primary,
      ...rest.filter((p) => p.id !== primary.id && (isLocalEndpoint(p) ? allowLocal : allowRemote)),
    ];
  const local = localFallbackProfile();
  if (local && !candidates.some((p) => p.kind === 'ollama' && p.baseUrl === local.baseUrl && p.model === local.model)) {
    candidates.push(local);
  }
  return candidates.map(resolveProfile);
}

function isLocalEndpoint(profile) {
  if (profile.kind === 'ollama' && /-cloud(?::[^:]*)?$/.test(profile.model || '')) return false;
  try {
    const host = new URL(profile.baseUrl).hostname;
    return ['localhost', '127.0.0.1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

function legacyProfile() {
  const s = settings();
  if (s.provider === 'openai') {
    return {
      id: 'legacy-openai',
      label: 'OpenAI-compatible (legacy settings)',
      kind: 'openai',
      baseUrl: s.openai.baseUrl,
      model: s.openai.model || s.model,
      apiKey: s.openai.apiKey,
    };
  }
  return {
    id: 'legacy-ollama',
    label: 'Ollama (legacy settings)',
    kind: 'ollama',
    baseUrl: s.ollamaUrl,
    model: s.model,
    apiKey: '',
  };
}

function localFallbackProfile() {
  const s = settings();
  if (s.routing?.localFallbackEnabled !== true) return null;
  return {
    id: 'ollama-local-fallback',
    label: 'Ollama local fallback',
    kind: 'ollama',
    baseUrl: String(s.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: s.routing?.localFallbackModel || 'qwen2.5:7b',
    apiKey: '',
  };
}

function resolveProfile(profile) {
  const savedKey = modelSecrets.get(profile.id);
  if (savedKey) return { ...profile, apiKey: savedKey };
  if (!profile.secretId) return profile;
  if (!vault.isUnlocked()) {
    return { ...profile, apiKey: '', credentialError: 'This provider still uses a legacy Vault key. Re-enter its API key here to move it to Windows secure storage.' };
  }
  try {
    return { ...profile, apiKey: vault.reveal(profile.secretId).password };
  } catch (e) {
    return { ...profile, apiKey: '', credentialError: `Could not read the provider key from Nexus Vault: ${e.message}` };
  }
}

export function resolvedProfile(id) {
  const profile = profiles().find((p) => p.id === id);
  return profile ? resolveProfile(profile) : null;
}

function normalize(p = {}) {
  const preset = PRESETS.find((x) => x.id === p.presetId) || {};
  return {
    id: p.id || uid('p_').slice(0, 10),
    label: String(p.label || preset.label || 'provider').slice(0, 40),
    kind: p.kind === 'ollama' ? 'ollama' : 'openai',
    baseUrl: String(p.baseUrl || preset.baseUrl || '').replace(/\/$/, ''),
    model: String(p.model || preset.model || ''),
    apiKey: String(p.apiKey || p.key || ''),
    secretId: String(p.secretId || ''),
    presetId: p.presetId || null,
    supportsVision: p.supportsVision === true || (!('supportsVision' in p) && preset.supportsVision === true),
    priority: Number(p.priority) || profiles().length + 1,
    addedAt: new Date().toISOString(),
  };
}

export function upsert(input) {
  const cur = profiles();
  const wanted = input.id ? cur.find((p) => p.id === input.id) : null;
  const submittedKey = String(input.apiKey || '');
  const useSubmittedKey = Boolean(submittedKey && !submittedKey.startsWith('••••'));
  const oldInlineKey = wanted?.apiKey || wanted?.key || '';
  const next = normalize({
    ...wanted,
    ...input,
    apiKey: '',
    key: '',
    secretId: useSubmittedKey ? '' : wanted?.secretId || '',
  });
  if (useSubmittedKey) modelSecrets.set(next.id, submittedKey);
  else if (oldInlineKey && !modelSecrets.has(next.id)) modelSecrets.set(next.id, oldInlineKey);
  delete next.key;
  const list = cur.filter((p) => p.id !== next.id);
  list.push(next);
  const shouldActivate = Boolean(next.model) && (!activeId() || input.activate);
  saveSettings({ providers: list, activeProviderId: activeId() || (next.model ? next.id : '') });
  // Mirror into the legacy single-provider settings so older code paths keep working.
  if (shouldActivate) activate(next.id);
  return next;
}

export function remove(id) {
  modelSecrets.remove(id);
  const list = profiles().filter((p) => p.id !== id);
  const stillActive = activeId() === id ? '' : activeId();
  saveSettings({ providers: list, activeProviderId: stillActive || list[0]?.id || '' });
  return list;
}

export function activate(id) {
  const p = profiles().find((x) => x.id === id);
  if (!p) throw new Error('no such provider');
  if (!p.model) throw new Error('choose a model before activating this provider');
  const patch = { activeProviderId: id, provider: p.kind === 'ollama' ? 'ollama' : 'openai', model: p.model };
  if (p.kind === 'ollama') {
    patch.ollamaUrl = p.baseUrl;
    if (isLocalEndpoint(p)) patch.routing = { localFallbackModel: p.model };
  } else patch.openai = { baseUrl: p.baseUrl, model: p.model };
  saveSettings(patch);
  return p;
}

/** Public list for the UI — keys masked. */
export function list() {
  const aid = activeId();
  return profiles().map((p) => {
    const { apiKey = '', key = '', secretId, ...safe } = p;
    const storedKey = apiKey || key;
    const modelKeyStored = modelSecrets.has(p.id);
    const modelKeyMode = modelSecrets.keyMode(p.id);
    return {
      ...safe,
      apiKey: storedKey ? '••••' + storedKey.slice(-4) : '',
      active: p.id === aid,
      hasKey: Boolean(storedKey || secretId || modelKeyStored),
      keyStorage: secretId ? 'vault-legacy' : modelKeyStored ? modelKeyMode : storedKey ? 'legacy-plaintext' : 'none',
      vaultLocked: Boolean(secretId && !vault.isUnlocked()),
    };
  });
}

export function storageMode() {
  return modelSecrets.mode();
}

export async function testProfile(id) {
  const saved = profiles().find((x) => x.id === id);
  if (!saved) throw new Error('no such provider');
  const p = resolveProfile(saved);
  const started = Date.now();
  if (p.credentialError) return { ok: false, error: p.credentialError, ms: Date.now() - started };
  if (p.kind === 'ollama') {
    const res = await fetchWithTimeout(`${p.baseUrl}/api/tags`, {}, 10000);
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    return { ok: true, ms: Date.now() - started, models: names, note: names.includes(p.model) ? 'model available' : `model "${p.model}" not in list` };
  }
  if (!(p.apiKey || p.key)) return { ok: false, error: 'no API key set for this provider' };
  try {
    const res = await fetchWithTimeout(`${p.baseUrl}/models`, { headers: { authorization: `Bearer ${p.apiKey || p.key}` } }, 15000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - started };
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id);
    return { ok: true, ms: Date.now() - started, models: ids.slice(0, 60), count: ids.length, hasModel: ids.includes(p.model) };
  } catch (e) {
    return { ok: false, error: truncate(e.message, 200), ms: Date.now() - started };
  }
}

/**
 * OpenRouter publishes its catalogue with prices and needs no key for this call, so we can show the
 * genuinely free models instead of guessing at names.
 */
export async function discoverFreeModels({ onlyFree = true, visionOnly = false } = {}) {
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {}, 25000);
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const data = await res.json();
  const rows = (data.data || []).map((m) => {
    const prompt = Number(m.pricing?.prompt ?? 1);
    const completion = Number(m.pricing?.completion ?? 1);
    const inputModalities = m.architecture?.input_modalities || m.input_modalities || [];
    const supportedParameters = m.supported_parameters || [];
    return {
      id: m.id,
      name: m.name,
      context: m.context_length || m.top_provider?.context_length || 0,
      free: prompt === 0 && completion === 0,
      priced: !(prompt === 0 && completion === 0),
      supportsVision: inputModalities.includes('image'),
      supportsTools: supportedParameters.includes('tools') || supportedParameters.includes('tool_choice'),
    };
  });
  const filtered = rows.filter((r) => (!onlyFree || r.free) && (!visionOnly || r.supportsVision));
  return {
    total: rows.length,
    free: rows.filter((r) => r.free).length,
    visionFree: rows.filter((r) => r.free && r.supportsVision).length,
    models: filtered.sort((a, b) => (b.context || 0) - (a.context || 0)).slice(0, 80),
  };
}
