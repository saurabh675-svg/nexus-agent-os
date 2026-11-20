/**
 * Token and cost meter.
 *
 * Streaming APIs often omit usage, so we estimate from characters (≈4 chars/token) and apply a price
 * table. Every figure is labelled "≈" — an estimate that pretends to be exact is worse than none.
 */

const PRICES = [
  // per 1M tokens, [input, output]
  { match: /ollama|-cloud$|:cloud|gemma|gpt-oss/i, in: 0, out: 0, label: 'Ollama (cloud free plan / local)' },
  { match: /llama-3\.3-70b|llama-3\.1-70b/i, in: 0.59, out: 0.79, label: 'Llama 70B class' },
  { match: /deepseek-chat/i, in: 0.27, out: 1.1, label: 'DeepSeek chat' },
  { match: /gemini-2\.0-flash|gemini-1\.5-flash/i, in: 0.1, out: 0.4, label: 'Gemini Flash' },
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6, label: 'GPT-4o mini' },
  { match: /gpt-4o/i, in: 2.5, out: 10, label: 'GPT-4o' },
  { match: /claude|sonnet|haiku|opus/i, in: 3, out: 15, label: 'Claude class (via gateway)' },
  { match: /:free/i, in: 0, out: 0, label: 'free tier' },
];

export function priceFor(model = '') {
  const m = String(model || '');
  return PRICES.find((p) => p.match.test(m)) || { in: 0, out: 0, label: 'unpriced (treated as free)' };
}

export function tokensOf(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

export function estimate({ model = '', promptText = '', completionText = '', steps = 1 } = {}) {
  const price = priceFor(model);
  // The prompt is re-sent every step, which is where agent loops quietly burn money.
  const inTok = tokensOf(promptText) * Math.max(1, steps);
  const outTok = tokensOf(completionText);
  const cost = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
  return {
    model,
    priceLabel: price.label,
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
    costUsd: Number(cost.toFixed(6)),
    approx: true,
  };
}

/** Process-wide running total, so the UI can show "this app has cost you X". */
let totals = { runs: 0, tokens: 0, costUsd: 0, since: new Date().toISOString() };

export function addRun(meter) {
  totals.runs += 1;
  totals.tokens += meter.totalTokens || 0;
  totals.costUsd = Number((totals.costUsd + (meter.costUsd || 0)).toFixed(6));
  return totals;
}

export function readTotals() {
  return { ...totals };
}

export function resetTotals() {
  totals = { runs: 0, tokens: 0, costUsd: 0, since: new Date().toISOString() };
  return totals;
}

export function format(meter) {
  const t = meter.totalTokens >= 1000 ? `${(meter.totalTokens / 1000).toFixed(1)}k` : String(meter.totalTokens);
  const c = meter.costUsd > 0 ? `$${meter.costUsd.toFixed(4)}` : 'free';
  return `≈${t} tok · ${c} · ${meter.priceLabel}`;
}
