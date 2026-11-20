import fs from 'node:fs';
import path from 'node:path';
import { settings, saveSettings, PLATFORM, ROOT } from './config.js';
import { fetchWithTimeout, truncate } from './util.js';
import * as kaggle from './kaggle.js';
import * as providers from './providers.js';
import * as discord from './discord.js';

/**
 * Connect: turn "go create a key" into something that mostly completes itself.
 *
 * Two kinds of automation are possible and only two:
 *  - files the service hands you (Kaggle writes kaggle.json to Downloads) → detect + parse + verify
 *  - tokens you paste (GitHub PAT, Discord bot token, bot keys) → save + verify with a real API call
 *
 * What we never do: sign in as you, solve a CAPTCHA, or create an account. Those need a human, and
 * pretending otherwise would just teach you to trust a lie.
 */

const DOWNLOADS = [path.join(PLATFORM.home, 'Downloads'), path.join(PLATFORM.home, 'Desktop')];

/** Newest kaggle.json in Downloads/Desktop, optionally only if recent. */
export function findKaggleJson({ minutes = 240 } = {}) {
  const cutoff = Date.now() - minutes * 60000;
  let best = null;
  for (const dir of DOWNLOADS) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^kaggle.*\.json$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs, size: st.size };
      } catch {}
    }
  }
  return best;
}

export async function detectKaggle() {
  const found = findKaggleJson();
  if (!found) {
    return {
      ok: false,
      error:
        'No recent kaggle.json in Downloads. On kaggle.com → Settings → API click “Create New Token”; the file downloads automatically. Then press detect again.',
      searched: DOWNLOADS,
    };
  }
  let creds;
  try {
    // Strip a UTF-8 BOM: editors and PowerShell add one, and JSON.parse rejects it.
    creds = JSON.parse(fs.readFileSync(found.file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, error: `found ${found.file} but it is not valid JSON: ${e.message}` };
  }
  if (!creds.username || !creds.key) return { ok: false, error: 'kaggle.json is missing username or key' };
  saveSettings({ kaggle: { username: creds.username, key: creds.key } });
  const cli = kaggle.writeKaggleJson();
  const who = await kaggle.whoAmI();
  return {
    ok: who.ok !== false,
    file: found.file,
    username: creds.username,
    cli,
    verify: who,
    note: who.ok === false ? 'saved, but the Kaggle API rejected it: ' + who.error : 'saved and verified with the Kaggle API',
  };
}

export async function saveGithub(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('paste a GitHub token');
  if (!/^(gh[pousr]_|github_pat_)/i.test(t)) throw new Error('that does not look like a GitHub token (expects ghp_ / github_pat_ …)');
  const res = await fetchWithTimeout('https://api.github.com/user', { headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json' } }, 15000);
  if (!res.ok) throw new Error(`GitHub rejected the token: HTTP ${res.status}`);
  const me = await res.json();
  saveSettings({ github: { token: t } });
  return { ok: true, login: me.login, name: me.name, repos: me.public_repos, note: 'verified against api.github.com' };
}

export async function saveDiscord(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('paste the bot token');
  saveSettings({ discord: { token: t } });
  try {
    const me = await discord.test();
    return { ok: true, username: me.username, id: me.id, note: 'verified with /users/@me — remember to enable MESSAGE CONTENT INTENT' };
  } catch (e) {
    return { ok: false, error: `saved, but Discord rejected it: ${truncate(String(e.message), 200)}` };
  }
}

export async function saveProviderKey({ presetId, apiKey, model }) {
  const preset = providers.PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error('unknown provider preset');
  const profile = providers.upsert({ label: preset.label, baseUrl: preset.baseUrl, model: model || preset.model, apiKey, kind: preset.kind, presetId });
  const test = await providers.testProfile(profile.id);
  return { ok: test.ok, profile: profile.id, label: preset.label, test };
}

export async function saveTelegram(token, chatId) {
  const t = String(token || '').trim();
  if (!t) throw new Error('paste the bot token from @BotFather');
  saveSettings({ telegram: { token: t, chatId: String(chatId || '').trim() } });
  const me = await fetchWithTimeout(`https://api.telegram.org/bot${t}/getMe`, {}, 15000);
  const data = await me.json().catch(() => ({}));
  if (!me.ok || !data.ok) return { ok: false, error: `Telegram rejected the token: ${truncate(JSON.stringify(data), 160)}` };
  let sent = null;
  const cid = String(chatId || '').trim();
  if (cid) {
    const r = await fetchWithTimeout(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cid, text: 'Nexus connected. This channel will receive automation results.' }),
    }, 15000);
    sent = r.ok;
  }
  return { ok: true, bot: data.result.username, sent, note: sent ? 'test message sent' : 'add a chat id to receive results' };
}

/** What each automation needs, so "make it work" is a checklist instead of guesswork. */
export function readiness() {
  const s = settings();
  const has = {
    kaggle: Boolean(s.kaggle?.username && s.kaggle?.key),
    google: Boolean(s.google?.refreshToken),
    github: Boolean(s.github?.token),
    discord: Boolean(s.discord?.token),
    telegram: Boolean(s.telegram?.token && s.telegram?.chatId),
    model: Boolean((s.providers || []).length || s.openai?.apiKey || s.model),
  };
  const needs = [
    { automation: 'Morning brief (calendar + mail)', needs: ['google'], why: 'reads Calendar and Gmail' },
    { automation: 'Email me a deck or report', needs: ['google'], why: 'sends through Gmail' },
    { automation: 'Kaggle kernel monitor', needs: ['kaggle'], why: 'status + log through the Kaggle API' },
    { automation: 'Opportunity radar digest', needs: ['discord'], why: 'pushes the digest out of band (Discord or Telegram)' },
    { automation: 'Bounty / PR watch', needs: ['github'], why: 'reads issues and pull requests' },
    { automation: 'Anything at all', needs: ['model'], why: 'no model, no agent' },
  ];
  return {
    has,
    ready: needs.map((n) => ({ ...n, ok: n.needs.every((k) => has[k]) })),
    anyOutOfBand: has.discord || has.telegram,
  };
}

export function status() {
  const s = settings();
  return {
    kaggle: { connected: Boolean(s.kaggle?.username && s.kaggle?.key), detail: s.kaggle?.username || '' },
    google: { connected: Boolean(s.google?.refreshToken), detail: s.google?.email || '' },
    github: { connected: Boolean(s.github?.token), detail: s.github?.token ? 'token saved' : '' },
    discord: { connected: Boolean(s.discord?.token), detail: s.discord?.runtime || (s.discord?.token ? 'token saved' : '') },
    telegram: { connected: Boolean(s.telegram?.token), detail: s.telegram?.chatId || '' },
    providers: providers.list(),
    readiness: readiness(),
  };
}
