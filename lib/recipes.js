/**
 * Recipes — portable, shareable agent workflows (inspired by goose recipes).
 * Stored as JSON under data/recipes/ so zero extra deps (no YAML parser needed).
 * A recipe packages: system prompt, preferred tools/skills, parameters, schedule hint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { ensureDir, uid, truncate } from './util.js';

const DIR = path.join(DATA, 'recipes');
ensureDir(DIR);

export function listRecipes() {
  ensureDir(DIR);
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        return {
          id: raw.id || f.replace(/\.json$/, ''),
          name: raw.name || f,
          description: raw.description || '',
          tags: raw.tags || [],
          schedule: raw.schedule || null,
          params: raw.params || {},
          updatedAt: raw.updatedAt || null,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function getRecipe(id) {
  const file = path.join(DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  if (!fs.existsSync(file)) throw new Error(`recipe not found: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveRecipe(recipe) {
  const id = String(recipe.id || recipe.name || uid())
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const body = {
    id,
    name: recipe.name || id,
    description: recipe.description || '',
    system: recipe.system || '',
    tools: recipe.tools || ['*'],
    skills: recipe.skills || [],
    params: recipe.params || {},
    schedule: recipe.schedule || null,
    tags: recipe.tags || [],
    maxSteps: recipe.maxSteps || 14,
    updatedAt: new Date().toISOString(),
  };
  ensureDir(DIR);
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(body, null, 2));
  return body;
}

export function deleteRecipe(id) {
  const file = path.join(DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true };
}

/** Expand {{param}} placeholders in a string. */
export function fillTemplate(str, params = {}) {
  return String(str || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{{${k}}}`,
  );
}

/**
 * Build the agent input + system overlay for a recipe run.
 */
export function prepareRecipeRun(id, paramValues = {}) {
  const r = getRecipe(id);
  const filledSystem = fillTemplate(r.system, paramValues);
  const task = fillTemplate(r.description || r.name, paramValues);
  // default missing params
  const params = { ...r.params };
  for (const [k, v] of Object.entries(paramValues || {})) params[k] = v;
  return {
    recipe: r,
    systemOverlay: filledSystem,
    task: task || `Run recipe ${r.name}`,
    tools: r.tools,
    skills: r.skills,
    maxSteps: r.maxSteps,
    params,
  };
}

export function seedExampleRecipes() {
  const examples = [
    {
      id: 'morning-brief',
      name: 'Morning Brief',
      description: 'Summarise calendar, unread mail, open Kaggle deadlines and system health for {{date}}.',
      system:
        'You are the morning briefing officer. Be concise. Use Gmail/Calendar if connected, web_search for competition deadlines, and memory/brain for open tasks. Output a short structured briefing.',
      tools: ['web_search', 'open_page', 'memory', 'brain', 'gmail', 'calendar'],
      tags: ['daily', 'briefing'],
      schedule: 'daily 08:30',
      params: { date: 'today' },
    },
    {
      id: 'research-brief',
      name: 'Research Brief',
      description: 'Deep research on: {{topic}}. Prefer primary sources, cite URLs, end with 5 bullet takeaways.',
      system:
        'You are a research sub-agent. Find verifiable facts. Prefer primary sources. Quote numbers. Cite URLs inline. Never invent a URL.',
      tools: ['web_search', 'open_page', 'browser', 'memory', 'skill'],
      tags: ['research'],
      params: { topic: '' },
      maxSteps: 16,
    },
    {
      id: 'business-opportunity-review',
      name: 'Business Opportunity Review',
      description:
        'Evaluate {{idea}} for {{market}} with a starting budget of {{budget}} and {{hours_per_week}} hours per week. Return sourced evidence, assumptions, unit economics, downside risks, and a low-cost validation test.',
      system:
        'Act as a skeptical business analyst, not a hype salesperson. Research current market evidence from primary sources where possible. Separate observed facts from estimates. Compare customer pain, competition, distribution, startup costs, time to first revenue, gross margin, and downside. Use conservative scenarios and show formulas. Recommend a small validation test before spending materially. Never guarantee income or returns, fabricate market sizes, or recommend illegal, deceptive, or high-risk financial activity. Cite URLs and dates. Ask for missing context rather than inventing the user’s budget, location, skills, or risk tolerance.',
      tools: ['web_search', 'open_page', 'memory', 'intel', 'radar', 'skill'],
      tags: ['business', 'economics', 'opportunity'],
      params: { idea: '', market: '', budget: 'not specified', hours_per_week: 'not specified' },
      maxSteps: 16,
    },
  ];
  for (const ex of examples) {
    const file = path.join(DIR, `${ex.id}.json`);
    if (!fs.existsSync(file)) saveRecipe(ex);
  }
}
