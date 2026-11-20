import { search, readPage } from './search.js';
import * as brain from './brain.js';
import * as kaggle from './kaggle.js';
import { fetchWithTimeout, truncate } from './util.js';

/**
 * Opportunity radar — India + world.
 *
 * Searches a fixed list of sources with explicit queries rather than crawling sites directly: it is
 * polite to the sites, survives layout changes, and the search engine already dedupes the web.
 * Extracted items go into the brain (kind: opportunity) so the agent can rank them against what it
 * knows about the person.
 */

const YEAR = new Date().getFullYear();

export const SOURCES = [
  { id: 'devpost', label: 'Devpost', group: 'competition', region: 'GLOBAL', query: `site:devpost.com hackathon ${YEAR} prizes open submissions` },
  { id: 'unstop', label: 'Unstop', group: 'competition', region: 'IN', query: `site:unstop.com competition ${YEAR} prize money students` },
  { id: 'devfolio', label: 'Devfolio', group: 'competition', region: 'IN', query: 'site:devfolio.co hackathon open now prizes' },
  { id: 'hackerearth', label: 'HackerEarth', group: 'competition', region: 'IN', query: `site:hackerearth.com challenges hiring hackathon ${YEAR}` },
  { id: 'catalyst', label: 'Catalyst / Unstop challenges', group: 'competition', region: 'IN', query: `Unstop Catalyst challenge ${YEAR} apply prize hackathon India` },
  { id: 'hackclub', label: 'Hack Club / student hacks', group: 'competition', region: 'GLOBAL', query: `student hackathon ${YEAR} open registration free entry prizes` },
  { id: 'amazon-science', label: 'Amazon Science challenges', group: 'competition', region: 'GLOBAL', query: `site:amazon.science/challenges OR site:amazon.science/research-awards ${YEAR} challenge competition` },
  { id: 'drivendata', label: 'DrivenData', group: 'competition', region: 'GLOBAL', query: `site:drivendata.org competitions open environmental climate data science ${YEAR}` },
  { id: 'zindi', label: 'Zindi', group: 'competition', region: 'GLOBAL', query: `site:zindi.africa competitions open remote sensing climate ${YEAR}` },
  { id: 'nasa-space-apps', label: 'NASA Space Apps', group: 'competition', region: 'GLOBAL', query: `site:spaceappschallenge.org ${YEAR} challenge earth science climate open` },
  { id: 'copernicus-masters', label: 'Copernicus Masters', group: 'competition', region: 'GLOBAL', query: `site:copernicus-masters.com ${YEAR} competition earth observation geospatial` },
  { id: 'geo-environment-challenges', label: 'Geoinformatics and environmental science', group: 'competition', region: 'GLOBAL', query: `geoinformatics GIS earth observation remote sensing environmental science climate competition challenge ${YEAR}` },
  { id: 'startupindia', label: 'Startup India', region: 'IN', query: `site:startupindia.gov.in seed fund scheme apply eligibility ${YEAR}` },
  { id: 'india-schemes', label: 'India public support', region: 'IN', query: `site:gov.in startup small business innovation scheme grant apply ${YEAR}` },
  { id: 'us-sbir', label: 'US SBIR / STTR', region: 'GLOBAL', query: `site:sbir.gov open solicitations small business research ${YEAR}` },
  { id: 'eu-funding', label: 'EU funding calls', region: 'GLOBAL', query: `site:europa.eu startup research innovation funding calls ${YEAR}` },
  { id: 'uk-innovation', label: 'UK innovation support', region: 'GLOBAL', query: `site:gov.uk innovation grant business funding apply ${YEAR}` },
  { id: 'public-tenders', label: 'Public tenders', region: 'GLOBAL', query: `government procurement tenders AI geospatial data science open bid ${YEAR}` },
  { id: 'research-prizes', label: 'Research prizes and challenges', group: 'competition', region: 'GLOBAL', query: `research challenge prize open call AI climate geoinformatics environmental science ${YEAR}` },
  { id: 'geospatial', label: 'Geospatial research opportunities', region: 'GLOBAL', query: `Earth observation GIS geospatial remote sensing research grant fellowship contract ${YEAR}` },
  { id: 'phd-research', label: 'Funded PhD and research assistant roles', region: 'GLOBAL', query: `funded PhD research assistant geoinformatics environmental science remote sensing climate ${YEAR} university official` },
  { id: 'faculty-roles', label: 'Assistant professor and faculty roles', region: 'GLOBAL', query: `assistant professor faculty geoinformatics environmental science remote sensing climate ${YEAR} university official` },
  { id: 'accelerators', label: 'Startup accelerators', region: 'GLOBAL', query: `global startup accelerator open applications grants funding ${YEAR}` },
  { id: 'kaggle', label: 'Kaggle', group: 'competition', region: 'GLOBAL', query: '' },
  { id: 'mlh', label: 'MLH', group: 'competition', region: 'GLOBAL', query: `Major League Hacking upcoming hackathons ${YEAR}` },
  { id: 'gsoc', label: 'Open source', region: 'GLOBAL', query: `GSoC ${YEAR} organizations stipend application timeline` },
  { id: 'bounties', label: 'Bounties', region: 'GLOBAL', query: `"bounty" machine learning engineer task paid ${YEAR}` },
  { id: 'grants', label: 'Global research grants and fellowships', region: 'GLOBAL', query: `research grant fellowship open call ${YEAR} environmental science geoinformatics climate official` },
  { id: 'remote', label: 'Remote work', region: 'GLOBAL', query: `remote data science contract hire ${YEAR}` },
];

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DEADLINE_RE = new RegExp(
  `(\\d{1,2}\\s*(?:${MONTHS})[a-z]*\\.?\\s*\\d{2,4})|((?:${MONTHS})[a-z]*\\.?\\s*\\d{1,2},?\\s*\\d{4})|deadline[^.]{0,40}?(\\d{1,2}\\s*(?:${MONTHS})[a-z]*|\\d{4}-\\d{2}-\\d{2})`,
  'i',
);
const MONEY_RE = /(?:₹|rs\.?|inr|\$|usd)\s?[\d,.]+\s?(?:k|lakh|crore|cr|m|mn|billion|million)?/gi;

export function extractDeadline(text) {
  const m = String(text).match(DEADLINE_RE);
  if (!m) return null;
  const raw = (m[1] || m[2] || m[3] || '').replace(/\s+/g, ' ').trim();
  const iso = Date.parse(raw.replace(/(\d)(st|nd|rd|th)/i, '$1'));
  return Number.isFinite(iso) ? new Date(iso).toISOString().slice(0, 10) : raw || null;
}

export function extractMoney(text) {
  const m = String(text).match(MONEY_RE);
  return m ? m.slice(0, 2).join(' + ') : null;
}

function regionOf(src, text) {
  if (src.region === 'IN') return 'IN';
  return /\bindia\b|\binr\b|₹|iit|nit\b|bangalore|bengaluru|delhi|mumbai/i.test(text) ? 'IN' : 'GLOBAL';
}

function scoreItem(item, profileSkills = []) {
  const hay = `${item.title} ${item.snippet}`.toLowerCase();
  let score = 20;
  for (const s of profileSkills) if (s && hay.includes(String(s).toLowerCase())) score += 12;
  if (/\b(geospatial|remote sensing|ndvi|earth engine|gis)\b/i.test(hay)) score += 10;
  if (/\b(kaggle|machine learning|data science|python|llm|ai)\b/i.test(hay)) score += 8;
  if (item.prize) score += 10;
  if (item.deadline) {
    const days = (Date.parse(item.deadline) - Date.now()) / 864e5;
    if (days > 0 && days < 30) score += 14;
    else if (days > 0 && days < 90) score += 6;
    else if (days < 0) score -= 15;
  }
  if (item.region === 'IN') score += 4;
  return Math.round(Math.min(score, 100));
}

function normalize(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/** One sweep. Returns items; with remember:true also writes them to the brain. */
export async function scan({ remember = true, max = 24, category = 'all' } = {}) {
  if (!['all', 'competition', 'opportunity'].includes(category)) throw new Error(`unknown radar category: ${category}`);
  const seen = new Map();
  const errors = [];
  const sources = category === 'all' ? SOURCES : SOURCES.filter((src) => (src.group === 'competition' ? 'competition' : 'opportunity') === category);

  for (const src of sources) {
    if (src.id === 'kaggle') {
      try {
        const comps = await kaggle.listCompetitions({ pageSize: 12 });
        for (const c of comps) {
          const key = normalize(c.url);
          if (seen.has(key)) continue;
          seen.set(key, {
            source: src.label,
            region: 'GLOBAL',
            title: c.title,
            url: c.url,
            snippet: [c.category, c.prize ? `prize ${c.prize}` : '', c.deadline ? `deadline ${String(c.deadline).slice(0, 10)}` : ''].filter(Boolean).join(' · '),
            deadline: c.deadline ? String(c.deadline).slice(0, 10) : null,
            prize: c.prize || null,
            kind: 'competition',
            category: 'competition',
          });
        }
      } catch (e) {
        errors.push(`kaggle: ${e.message}`);
      }
      continue;
    }

    try {
      const r = await search(src.query, { max: 5 });
      for (const hit of r.results) {
        const key = normalize(hit.url);
        if (!key || seen.has(key)) continue;
        const text = `${hit.title} ${hit.snippet}`;
        seen.set(key, {
          source: src.label,
          region: regionOf(src, text),
          title: truncate(hit.title, 160),
          url: hit.url,
          snippet: truncate(hit.snippet || '', 260),
          deadline: extractDeadline(text),
          prize: extractMoney(text),
          kind: src.group === 'competition' ? 'competition' : /grant|fund|scheme|support/i.test(src.label) ? 'grant' : /remote|professor|PhD|research assistant/i.test(src.label) ? 'job' : 'research',
          category: src.group === 'competition' ? 'competition' : 'opportunity',
        });
      }
    } catch (e) {
      errors.push(`${src.id}: ${e.message}`);
    }
  }

  const skills = (brain.profile().preferences || []).map((p) => p.replace(/^- /, '')).filter(Boolean);
  const rankingSkills = [...new Set([...skills, 'python', 'kaggle', 'geospatial', 'earth engine', 'research'])];
  const items = [...seen.values()]
    .map((i) => ({
      ...i,
      kind: i.category === 'competition'
        ? 'competition'
        : /grant|fund|scheme|support|sbir|tender|procurement/i.test(i.source)
        ? 'funding'
        : /bount|remote|work|contract/i.test(i.source)
          ? 'paid-work'
          : /research|geospatial|earth observation|PhD|professor/i.test(i.source)
            ? 'research'
            : i.kind,
      score: scoreItem(i, rankingSkills),
    }))
    .filter((i) => i.score > 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  let saved = 0;
  if (remember) {
    for (const i of items) {
      try {
        const exists = brain.search(i.title, 3).some((b) => b.meta?.url === i.url || b.title === i.title);
        if (exists) continue;
        brain.add({
          kind: 'competition',
          title: `${i.title} — ${i.source}`,
          body: `${i.snippet}\n${i.prize ? 'Prize: ' + i.prize + '\n' : ''}${i.deadline ? 'Deadline: ' + i.deadline + '\n' : ''}${i.url}`,
          tags: ['radar', i.region.toLowerCase(), i.kind],
          source: 'radar',
          confidence: 'medium',
          meta: { url: i.url, deadline: i.deadline, prize: i.prize, region: i.region, score: i.score, kind: i.kind, category: i.category, source: i.source },
        });
        saved++;
      } catch {}
    }
  }

  return { items, saved, errors, at: new Date().toISOString(), skillsHint: skills.length ? 'personalised' : 'generic' };
}

/** Compact text digest, used by the chat summary and the Discord post. */
export function digestText(result, limit = 8) {
  if (!result?.items?.length) return 'Radar found nothing this sweep.';
  const lines = [`Opportunity radar — ${new Date(result.at).toLocaleString()}`, ''];
  for (const i of result.items.slice(0, limit)) {
    const bits = [i.region, i.deadline ? `due ${i.deadline}` : null, i.prize].filter(Boolean).join(' · ');
    lines.push(`• ${i.title}`);
    lines.push(`  ${bits}`);
    lines.push(`  ${i.url}`);
  }
  return lines.join('\n');
}

/** Open one result in the built-in browser and pull the useful fields out of the page. */
export async function dive(url) {
  const page = await readPage(url, 12000);
  const text = page.text || '';
  return {
    url,
    status: page.status,
    deadline: extractDeadline(text),
    prize: extractMoney(text),
    eligibility: truncate(
      (text.match(/(?:eligibility|who can apply|requirements)[^.]{0,300}\./i) || [''])[0],
      400,
    ),
    excerpt: truncate(text, 1500),
  };
}
