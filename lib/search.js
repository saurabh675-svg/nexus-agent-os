import { settings } from './config.js';
import { fetchText, htmlToText, decodeEntities, truncate, fetchWithTimeout } from './util.js';

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = (r.url || r.title || '').replace(/\/$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** DuckDuckGo HTML endpoint — no API key required. */
async function ddg(query, max) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      const { text } = await fetchText(url);
      const results = [];
      const blocks = text.split(/<div[^>]+class="[^"]*result__body[^"]*"/i).slice(1);
      for (const b of blocks) {
        const link = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!link) continue;
        let href = decodeEntities(link[1]);
        const m = href.match(/uddg=([^&]+)/);
        if (m) {
          try {
            href = decodeURIComponent(m[1]);
          } catch {}
        }
        if (href.startsWith('//')) href = 'https:' + href;
        if (!/^https?:/i.test(href)) continue;
        const snippet = b.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        results.push({
          title: htmlToText(link[2]).slice(0, 200),
          url: href,
          snippet: snippet ? truncate(htmlToText(snippet[1]), 400) : '',
          source: 'duckduckgo',
        });
        if (results.length >= max) break;
      }
      if (results.length) return results;
      lastErr = new Error('empty result page (possible rate limit)');
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 + attempt * 500));
  }
  throw lastErr || new Error('duckduckgo failed');
}

async function ddgLite(query, max) {
  const { text } = await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query));
  const results = [];
  const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(text)) && results.length < max) {
    results.push({
      title: htmlToText(m[2]).slice(0, 200),
      url: decodeEntities(m[1]),
      snippet: truncate(htmlToText(m[3]), 400),
      source: 'duckduckgo-lite',
    });
  }
  return results;
}

async function searx(query, max, baseUrl) {
  const base = (baseUrl || 'https://searx.be').replace(/\/$/, '');
  const { text, status } = await fetchText(
    `${base}/search?q=${encodeURIComponent(query)}&format=json`,
    { headers: { accept: 'application/json' } },
  );
  if (status !== 200) throw new Error(`SearXNG returned ${status}`);
  const data = JSON.parse(text);
  return (data.results || []).slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: truncate(r.content || '', 400),
    source: r.engine || 'searxng',
  }));
}

async function brave(query, max, key) {
  const res = await fetchWithTimeout(
    'https://api.search.brave.com/res/v1/web/search?count=' + Math.min(max, 20) + '&q=' + encodeURIComponent(query),
    { headers: { 'X-Subscription-Token': key, accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: truncate(htmlToText(r.description || ''), 400),
    source: 'brave',
  }));
}

async function tavily(query, max, key) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: max, include_answer: true }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: truncate(r.content || '', 500),
    source: 'tavily',
  }));
  return results;
}

export async function search(query, opts = {}) {
  const cfg = settings().search;
  const max = Math.min(Math.max(Number(opts.max) || cfg.maxResults || 6, 1), 20);
  const provider = opts.provider || cfg.provider || 'ddg';
  const errors = [];

  const attempt = async (name, fn) => {
    try {
      const r = await fn();
      if (r && r.length) return dedupe(r).slice(0, max);
      errors.push(`${name}: no results`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
    return null;
  };

  let results = null;
  if (provider === 'brave' && cfg.braveKey) results = await attempt('brave', () => brave(query, max, cfg.braveKey));
  if (provider === 'tavily' && cfg.tavilyKey) results = await attempt('tavily', () => tavily(query, max, cfg.tavilyKey));
  if (provider === 'searx') results = await attempt('searx', () => searx(query, max, cfg.searxUrl));

  if (!results) results = await attempt('duckduckgo', () => ddg(query, max));
  if (!results) results = await attempt('duckduckgo-lite', () => ddgLite(query, max));
  if (!results) results = await attempt('searx-fallback', () => searx(query, max, cfg.searxUrl));

  return { query, provider, results: results || [], errors };
}

/** Readable text of one page, capped. */
export async function readPage(url, maxChars = 9000) {
  const { text: html, status, url: finalUrl } = await fetchText(url, {}, 30000);
  const isJson = /^\s*[{[]/.test(html.slice(0, 200));
  const body = isJson ? html : htmlToText(html);
  return {
    status,
    url: finalUrl,
    text: truncate(body, maxChars),
    bytes: html.length,
  };
}
