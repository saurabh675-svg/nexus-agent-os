import { settings, saveSettings } from './config.js';

/**
 * Accounts registry.
 *
 * The starter list contains public service links only. User handles and email addresses are supplied
 * locally and are never seeded into a fresh installation.
 */

const SEED = [
  {
    id: 'kaggle',
    service: 'Kaggle',
    url: 'https://www.kaggle.com/competitions',
    handle: '',
    email: '',
    watch: 'https://www.kaggle.com/competitions',
    notes: 'Competitions and datasets.',
    source: 'default:service-catalog',
  },
  {
    id: 'devpost',
    service: 'Devpost',
    url: 'https://devpost.com/',
    handle: '',
    email: '',
    watch: 'https://devpost.com/hackathons',
    notes: 'Hackathon listings — named in the cross-platform opportunity monitor.',
    source: 'default:service-catalog',
  },
  {
    id: 'unstop',
    service: 'Unstop',
    url: 'https://unstop.com/',
    handle: '',
    email: '',
    watch: 'https://unstop.com/competitions',
    notes: 'Competitions and challenges — named in the opportunity monitor.',
    source: 'default:service-catalog',
  },
  {
    id: 'contra',
    service: 'Contra',
    url: 'https://contra.com/',
    handle: '',
    email: '',
    watch: 'https://contra.com/opportunities',
    notes: 'Freelance projects — named in the opportunity monitor.',
    source: 'default:service-catalog',
  },
  {
    id: 'hackerrank',
    service: 'HackerRank',
    url: 'https://www.hackerrank.com/',
    handle: '',
    email: '',
    watch: 'https://www.hackerrank.com/contests',
    notes: 'Contests and hiring challenges.',
    source: 'default:service-catalog',
  },
  {
    id: 'huggingface',
    service: 'Hugging Face',
    url: 'https://huggingface.co/',
    handle: '',
    email: '',
    watch: 'https://huggingface.co/models?sort=trending',
    notes: 'Models, datasets and Spaces.',
    source: 'default:service-catalog',
  },
  {
    id: 'amazon-research',
    service: 'Amazon Research Awards',
    url: 'https://www.amazon.science/research-awards',
    handle: '',
    email: '',
    watch: 'https://www.amazon.science/research-awards',
    notes: 'Research award opportunities.',
    source: 'default:service-catalog',
  },
  {
    id: 'tradingview',
    service: 'TradingView',
    url: 'https://www.tradingview.com/',
    handle: '',
    email: '',
    watch: '',
    notes: 'Paper-trading strategy checked at US market open. No live orders.',
    source: 'default:service-catalog',
  },
  {
    id: 'gmail',
    service: 'Gmail',
    url: 'https://mail.google.com/',
    handle: '',
    email: '',
    watch: '',
    notes: 'Connect Google to use Gmail.',
    source: 'default:service-catalog',
  },
];

export function ensureSeeded() {
  const cur = settings().accounts;
  if (Array.isArray(cur) && cur.length) return cur;
  saveSettings({ accounts: SEED });
  return SEED;
}

export function list() {
  return ensureSeeded();
}

export function upsert(patch) {
  const cur = list();
  const id = patch.id || String(patch.service || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const next = { ...(cur.find((a) => a.id === id) || { id }), ...patch, id };
  saveSettings({ accounts: [...cur.filter((a) => a.id !== id), next] });
  return next;
}

export function remove(id) {
  const next = list().filter((a) => a.id !== id);
  saveSettings({ accounts: next });
  return next;
}

/** Every distinct sign-in email we know about, with the services using it. */
export function emails() {
  const map = new Map();
  for (const a of list()) {
    const e = (a.email || '').trim();
    if (!e) continue;
    map.set(e, [...(map.get(e) || []), a.service]);
  }
  return [...map.entries()].map(([email, services]) => ({ email, services }));
}
