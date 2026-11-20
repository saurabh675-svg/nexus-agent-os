import { settings } from './config.js';
import { fetchWithTimeout, truncate, sleep } from './util.js';
import * as browser from './browser.js';
import * as providers from './providers.js';

/**
 * Vision-grounded browser control.
 *
 * The DOM path (element indices, labels) is precise and cheap — it should always be tried first.
 * Vision is the fallback for what the DOM cannot describe: canvas widgets, image maps, custom
 * editors, a screenshot you want the model to look at.
 *
 * Your Ollama instance has gemma4:31b-cloud, which accepts images. We ask it for the element centre as
 * a *fraction* of the screenshot, because models are far more reliable at "half way across, slightly
 * down" than at exact pixels.
 */

export const DEFAULT_VISION_MODEL = 'qwen3-vl:4b';

export function visionModel() {
  return settings().visionModel || DEFAULT_VISION_MODEL;
}

function visionProfile() {
  const id = settings().visionProviderId || 'ollama';
  if (id === 'ollama') {
    return {
      id,
      label: 'Ollama local',
      kind: 'ollama',
      baseUrl: settings().ollamaUrl,
      model: visionModel(),
      apiKey: '',
    };
  }
  const profile = providers.resolvedProfile(id);
  if (!profile) throw new Error(`Selected vision provider "${id}" is not configured.`);
  if (!profile.supportsVision) throw new Error(`Provider "${profile.label}" is not marked as image-capable.`);
  if (profile.credentialError) throw new Error(profile.credentialError);
  let host;
  try {
    host = new URL(profile.baseUrl).hostname;
  } catch {
    throw new Error(`Provider "${profile.label}" has an invalid base URL.`);
  }
  if (!(profile.apiKey || profile.key) && !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new Error(`Provider "${profile.label}" needs an API key before it can receive screenshots.`);
  }
  return profile;
}

export async function askVision({ images, prompt, model, timeoutMs = 180000 }) {
  const p = visionProfile();
  const m = model || p.model;
  const imageList = (images || []).map((image) => String(image).replace(/^data:image\/[^;]+;base64,/i, ''));
  let url;
  let headers = { 'content-type': 'application/json' };
  let payload;
  if (p.kind === 'ollama') {
    url = `${p.baseUrl.replace(/\/$/, '')}/api/generate`;
    payload = { model: m, prompt, images: imageList, stream: false, options: { temperature: 0.1, num_predict: 500 } };
  } else {
    url = `${p.baseUrl.replace(/\/$/, '')}/chat/completions`;
    if (p.apiKey || p.key) headers.authorization = `Bearer ${p.apiKey || p.key}`;
    payload = {
      model: m,
      stream: false,
      temperature: 0.1,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageList.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } })),
        ],
      }],
    };
  }
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeoutMs);
  if (!res.ok) throw new Error(`vision model ${m} via ${p.label || p.id} returned HTTP ${res.status}: ${truncate(await res.text(), 200)}`);
  const data = await res.json();
  const output = p.kind === 'ollama' ? data.response : data.choices?.[0]?.message?.content;
  const text = Array.isArray(output) ? output.map((part) => part.text || '').join('\n') : output;
  if (!String(text || '').trim()) throw new Error(`vision model ${m} via ${p.label || p.id} returned an empty response.`);
  return { model: m, provider: p.label || p.id, text: String(text).trim() };
}

/** Look at the current page and answer a question about it. */
export async function see({ question, model } = {}) {
  const shot = await browser.screenshot({});
  const prompt = question
    ? `This is a screenshot of a web browser. Answer concisely: ${question}`
    : 'Describe this web page in three short lines: what page it is, what the main content is, and what actions are available.';
  const r = await askVision({ images: [shot.base64], prompt, model });
  return { ok: true, file: shot.file, ...r };
}

/** Find where an element is, as CSS pixel coordinates in the live viewport. */
export async function locate({ target, model } = {}) {
  if (!target) throw new Error('locate needs a target description, e.g. "the Publish button"');
  const shot = await browser.screenshot({});
  const snap = await browser.snapshot().catch(() => null);
  const prompt = `You are clicking inside a web browser window. Find the element described as: "${target}".

Reply with ONLY minified JSON, no markdown:
{"found":true,"x":<number between 0 and 1>,"y":<number between 0 and 1>,"label":"short label of what you found"}
or
{"found":false,"note":"why you cannot find it"}

x and y are the click point as a fraction of the screenshot width and height (0 = left/top, 1 = right/bottom).`;
  const r = await askVision({ images: [shot.base64], prompt, model });

  let parsed = null;
  const m = r.text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      parsed = JSON.parse(m[0]);
    } catch {}
  }
  if (!parsed || parsed.found === false) {
    return {
      ok: false,
      model: r.model,
      note: parsed?.note || truncate(r.text, 200),
      snapshotTitle: snap?.title,
      raw: truncate(r.text, 300),
    };
  }
  const xf = Math.max(0, Math.min(1, Number(parsed.x)));
  const yf = Math.max(0, Math.min(1, Number(parsed.y)));
  const vp = await browser.evaluate('({w: innerWidth, h: innerHeight})').catch(() => null);
  const w = vp?.w || 1280;
  const h = vp?.h || 720;
  return {
    ok: true,
    model: r.model,
    label: parsed.label || null,
    x: Math.round(xf * w),
    y: Math.round(yf * h),
    fraction: { x: xf, y: yf },
    viewport: { w, h },
  };
}

/** Screenshot → model → mouse click. No DOM involved on the locate step. */
export async function clickByVision({ target, model } = {}) {
  const loc = await locate({ target, model });
  if (!loc.ok) return loc;
  await browser.mouseClick({ x: loc.x, y: loc.y });
  await sleep(700);
  const after = await browser.snapshot().catch(() => null);
  return {
    ...loc,
    clicked: true,
    url: after?.url,
    title: after?.title,
    text: after ? truncate(after.text, 1200) : undefined,
  };
}
