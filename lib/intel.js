import { settings } from './config.js';
import { search } from './search.js';
import * as kaggle from './kaggle.js';
import * as brain from './brain.js';
import { fetchWithTimeout, truncate } from './util.js';

/**
 * Opportunity intelligence: where money actually is, scored against the person's real capacity,
 * plus a compliance layer. The compliance layer exists because "not getting banned" is a policy
 * problem, not a secrecy problem — the fix is knowing the rule before you act, not hiding from it.
 */

/* ------------------------------ compliance ------------------------------ */

export const PLATFORM_RULES = [
  {
    platform: 'Discord',
    safe: ['Use one account per person', 'Bot posts only in servers that invited it', 'Respect per-server rate limits (5 msgs / few seconds)'],
    never: ['Self-botting / user-token automation (instant ban)', 'Mass DMs or unsolicited invites', 'Raiding or joining to advertise', 'Evading a ban with a new account'],
  },
  {
    platform: 'Kaggle',
    safe: ['Multiple kernels per competition', 'Public notebooks and datasets', 'Team merges within the stated limit'],
    never: ['Multiple accounts to get extra submissions', 'Sharing/leaking private test labels', 'Private sharing of competition data', 'Automating submission spam'],
  },
  {
    platform: 'GitHub',
    safe: ['One account, real identity optional', 'Bots via GitHub Apps / PAT with minimal scopes', 'Opening PRs and issues as a human would'],
    never: ['Scraping at high rate against the API terms', 'Fake stars/followers', 'Committing secrets or leaked data', 'Creating accounts to dodge limits or bans'],
  },
  {
    platform: 'Google / Gmail',
    safe: ['OAuth for your own account', 'Bulk mail only to opted-in recipients', 'One person, one primary account'],
    never: ['Cold-email blasting (gets the account suspended)', 'Sharing OAuth tokens', 'Automating account creation'],
  },
  {
    platform: 'Freelance platforms (Upwork/Fiverr)',
    safe: ['Applications tailored per job', 'Deliver work you can actually do'],
    never: ['Multiple accounts', 'Off-platform payment to dodge fees', 'Misrepresenting portfolio work'],
  },
];

export function rulesFor(platform) {
  const hit = PLATFORM_RULES.find((p) => p.platform.toLowerCase().includes(String(platform || '').toLowerCase()));
  if (!hit) return { platform, note: 'No curated entry — read the current ToS before automating anything.', all: PLATFORM_RULES };
  return hit;
}

/* -------------------------------- GitHub -------------------------------- */

async function gh(pathname, { token } = {}) {
  const t = token ?? settings().github?.token ?? '';
  const res = await fetchWithTimeout(`https://api.github.com${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'nexus-agent',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
  }, 20000);
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${truncate(text, 200)}`);
  return JSON.parse(text);
}

export async function githubIssues(query, { limit = 10, labels } = {}) {
  const q = [query, 'is:issue', 'is:open', labels ? `label:"${labels}"` : ''].filter(Boolean).join(' ');
  const data = await gh(`/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}&sort=updated`);
  return (data.items || []).map((i) => ({
    title: i.title,
    url: i.html_url,
    repo: i.repository_url?.split('/repos/')[1],
    labels: (i.labels || []).map((l) => l.name),
    comments: i.comments,
    updated: i.updated_at,
    state: i.state,
  }));
}

export async function githubPRs(repo, { state = 'open', limit = 10 } = {}) {
  const data = await gh(`/repos/${repo}/pulls?state=${state}&per_page=${limit}`);
  return (data || []).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login,
    draft: p.draft,
    branch: p.head?.ref,
    updated: p.updated_at,
  }));
}

export async function githubRepo(repo) {
  const d = await gh(`/repos/${repo}`);
  return {
    full_name: d.full_name,
    description: d.description,
    stars: d.stargazers_count,
    language: d.language,
    open_issues: d.open_issues_count,
    url: d.html_url,
    default_branch: d.default_branch,
  };
}

/* ------------------------------ opportunities --------------------------- */

function scoreOpportunity(o, { hoursPerWeek = 10, skills = [] } = {}) {
  const payout = Number(o.payout || 0);
  const effort = Math.max(Number(o.effortHours || 10), 1);
  const hourly = payout / effort;
  const hay = `${o.title} ${(o.tags || []).join(' ')}`.toLowerCase();
  const skillList = Array.isArray(skills) ? skills : String(skills || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fit = skillList.length ? skillList.filter((s) => hay.includes(String(s).toLowerCase())).length / skillList.length : 0.3;
  const urgency = o.deadline ? Math.max(0, 1 - (Date.parse(o.deadline) - Date.now()) / (90 * 864e5)) : 0.4;
  const realistic = effort <= hoursPerWeek * 4 ? 1 : 0.45;
  const score = Math.round((hourly * 0.6 + fit * 30 + urgency * 15) * realistic);
  return { hourly: Math.round(hourly), fit: Math.round(fit * 100), score };
}

export async function opportunities({ hoursPerWeek = 10, skills = [], limit = 8 } = {}) {
  const out = [];
  const skillList = Array.isArray(skills) ? skills : String(skills || '').split(',').map((s) => s.trim()).filter(Boolean);

  // Paid competitions — the only "make money" path with a known, honest expected value.
  try {
    const comps = await kaggle.listCompetitions({ pageSize: 20 });
    for (const c of comps.slice(0, 8)) {
      const prize = String(c.prize || '').replace(/[^0-9]/g, '');
      out.push({
        kind: 'competition',
        title: c.title,
        url: c.url,
        payout: Number(prize) || 0,
        effortHours: 60,
        deadline: c.deadline,
        tags: ['kaggle', c.category || '', 'ml'],
        note: prize ? `prize pool ~$${prize}` : 'ranking / jobs, not cash',
      });
    }
  } catch (e) {
    out.push({ kind: 'note', title: 'Kaggle unavailable — connect credentials in Settings', payout: 0, effortHours: 1, tags: [] });
  }

  // Bounty-labelled GitHub issues — real, small, paid work.
  const SPAM = /airdrop|crypto|token|\$w[a-z]+|usdt|nft|referral|presale|giveaway/i;
  for (const q of ['label:bounty', '"bounty" in:title']) {
    try {
      const items = await githubIssues(q, { limit: 8 });
      for (const i of items) {
        const hay = `${i.title} ${i.labels.join(' ')}`;
        if (SPAM.test(hay)) continue;
        if (!/bounty|\$|\bpaid\b/i.test(hay)) continue;
        const amount = hay.match(/\$\s?([0-9][0-9,]{1,7})/);
        out.push({
          kind: 'bounty',
          title: i.title,
          url: i.url,
          payout: amount ? Number(amount[1].replace(/,/g, '')) : 0,
          effortHours: amount && Number(amount[1].replace(/,/g, '')) > 300 ? 16 : 8,
          tags: ['github', 'bounty', i.repo || ''],
          note: `labels: ${i.labels.join(', ') || '—'}`,
        });
      }
    } catch {}
  }

  // Gig / contract leads, only from sources that allow being read.
  try {
    const r = await search('freelance data science contract remote hiring now', { max: 5 });
    for (const hit of r.results.slice(0, 3)) {
      out.push({ kind: 'gig', title: hit.title, url: hit.url, payout: 0, effortHours: 20, tags: ['freelance'], note: truncate(hit.snippet, 160) });
    }
  } catch {}

  const seen = new Set();
  return out
    .filter((o) => {
      const key = o.url || o.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return o.kind !== 'note';
    })
    .map((o) => ({ ...o, ...scoreOpportunity(o, { hoursPerWeek, skills: skillList }) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ------------------------------- money plan ----------------------------- */

export function plan({ hoursPerWeek = 10, skills = [], goal = 'extra income' } = {}) {
  const h = Number(hoursPerWeek) || 10;
  return {
    goal,
    hoursPerWeek: h,
    lanes: [
      {
        lane: 'Competition upside',
        share: Math.round(h * 0.4),
        why: 'Highest ceiling, honest expected value is low per attempt — treat it as a portfolio, not a paycheck.',
        firstStep: 'Pick one open competition with a real prize, run a baseline this week, submit once. Reaching the leaderboard matters more than winning the first one.',
      },
      {
        lane: 'Paid bounties / small contracts',
        share: Math.round(h * 0.35),
        why: 'Cash in weeks, not months, and builds a public track record you can point at.',
        firstStep: 'Ship two small bounty PRs. Each one becomes a portfolio line and a reference.',
      },
      {
        lane: 'Productised skill',
        share: Math.round(h * 0.15),
        why: 'Turns the same work into something that repeats without your hours — notebook, template, or a fixed-scope service.',
        firstStep: 'Package the thing you already built (Kaggle pipeline, GEE mapping, deck automation) as a fixed-price offer.',
      },
      {
        lane: 'Learning / leverage',
        share: Math.round(h * 0.1),
        why: 'Compounds; without it the other lanes cap out.',
        firstStep: 'One new technique per week that directly raises your competition or bounty throughput.',
      },
    ],
    guardrails: [
      'Never pay to enter anything that promises a guaranteed payout.',
      'Never use a second account on any platform to get more attempts — that is the fastest way to lose the account that has your history.',
      'Declare AI assistance where the rules require it (Kaggle competitions often do).',
      'Keep one clean identity per platform; the compounding value is the account, not the trick.',
    ],
    skills,
  };
}

/** Feed the brain so the plan is grounded in reality rather than a generic list. */
export function rememberPlan(p = plan()) {
  const saved = [];
  for (const lane of p.lanes) {
    saved.push(brain.add({ kind: 'task', title: `Money lane: ${lane.lane}`, body: `${lane.why}\nFirst step: ${lane.firstStep}`, tags: ['money', 'plan'], source: 'intel' }));
  }
  return saved;
}
