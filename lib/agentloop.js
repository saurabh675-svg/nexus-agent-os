import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, PLATFORM, WORKSPACE, settings } from './config.js';
import { chatStream, LLMError } from './llm.js';
import { toolHelp, runTool, TOOLS } from './tools.js';
import * as memory from './memory.js';
import * as skills from './skills.js';
import * as brain from './brain.js';
import * as preview from './preview.js';
import * as telemetry from './telemetry.js';
import * as projectctx from './projectctx.js';
import { truncate, uid } from './util.js';

const ROLES_FILE = path.join(AGENTS, 'roles.json');

export const DEFAULT_ROLES = {
  core: {
    name: 'Nexus',
    emoji: '◈',
    system: 'You are Nexus, the user’s own agent running on their PC. You act, you do not just advise.',
    tools: '*',
    temperature: 0.4,
  },
  researcher: {
    name: 'Researcher',
    emoji: '◎',
    system:
      'You are a research sub-agent. Find verifiable facts fast using web_search and open_page and the live browser. Prefer primary sources, quote exact numbers, and cite URLs inline. Never invent a URL.',
    tools: ['web_search', 'open_page', 'browser', 'memory', 'skill'],
    temperature: 0.2,
  },
  analyst: {
    name: 'Analyst',
    emoji: '◮',
    system:
      'You are an analysis sub-agent. Break the question into parts, weigh constraints, compare options, and give one clear recommendation with the reasoning and the main risk.',
    tools: ['web_search', 'open_page', 'memory', 'skill', 'shell', 'files'],
    temperature: 0.3,
  },
  business_analyst: {
    name: 'Business Analyst',
    emoji: '▣',
    system:
      'You are a rigorous business and economics analyst. Research current, verifiable evidence; cite primary sources; distinguish facts, estimates, and assumptions; show unit economics and downside risks; propose a low-cost validation experiment before a large commitment. Never promise wealth, invent returns, or present speculation as certainty. Flag legal, tax, and investment questions for qualified professionals.',
    tools: ['web_search', 'open_page', 'memory', 'intel', 'radar', 'files'],
    temperature: 0.2,
  },
  planner: {
    name: 'Planner',
    emoji: '◫',
    system:
      'You are a planning sub-agent. Produce an ordered, verifiable execution plan: numbered steps, each with the concrete action, the tool needed and the pass/fail check. No fluff.',
    tools: ['web_search', 'memory', 'skill', 'files'],
    temperature: 0.2,
  },
  executor: {
    name: 'Executor',
    emoji: '⚙',
    system:
      'You are an execution sub-agent with real shell and filesystem access on a Windows PC. Do the work: write files, run python/powershell, run kaggle jobs, verify the output, report exactly what you ran and what happened.',
    tools: ['shell', 'files', 'web_search', 'open_page', 'kaggle', 'browser', 'memory', 'skill'],
    temperature: 0.2,
  },
  critic: {
    name: 'Critic',
    emoji: '⚖',
    system:
      'You are an independent reviewer. Read the deliverable against the request and list concrete, evidence-backed defects first, then the smallest fixes. Do not praise.',
    tools: ['web_search', 'open_page', 'files', 'memory', 'skill'],
    temperature: 0.2,
  },
  writer: {
    name: 'Writer',
    emoji: '✎',
    system:
      'You are a writing sub-agent. Produce publication-quality prose in the language of the source material: clear structure, no filler, no invented facts, no emoji unless asked.',
    tools: ['memory', 'skill', 'files', 'web_search'],
    temperature: 0.5,
  },
  viz: {
    name: 'Data viz',
    emoji: '▤',
    system:
      'You are a data visualisation sub-agent. Choose the correct chart for the data shape, keep one consistent encoding, and state the conclusion each chart supports.',
    tools: ['shell', 'files', 'web_search', 'memory', 'skill'],
    temperature: 0.3,
  },
};

export function roles() {
  if (!fs.existsSync(ROLES_FILE)) fs.writeFileSync(ROLES_FILE, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf8');
  try {
    return { ...DEFAULT_ROLES, ...JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')) };
  } catch {
    return DEFAULT_ROLES;
  }
}

const PROTOCOL = `## How to act
You can use tools. To call one, end your message with exactly one fenced block:

\`\`\`tool
{"tool":"web_search","args":{"query":"latest kaggle competition deadline"}}
\`\`\`

Rules for tools:
- One tool per turn. After the block, stop and wait — the result comes back as a TOOL RESULT message.
- Never invent a tool result. Never put two tool blocks in one message.
- Prefer acting over asking. If a task can be done with your tools, do it.
- When the task is finished, give the final answer as normal text with NO tool block.
- Keep final answers tight: lead with the result, then the details a person needs.`;

export function systemPrompt({ role = 'core', extra = '', query = '' } = {}) {
  const r = roles()[role] || roles().core;
  const s = settings();
  const enabled = skills.menu();
  const knowledge = brain.context(query, 2200);
  const prof = brain.profileText();
  const project = projectctx.load();
  const skillText = skills.bodiesFor(query, 3200);
  const mem = memory.search(query || '', 4);
  const memBlock = mem.length ? mem.map((m) => `- ${truncate(m.text, 220)}`).join('\n') : '';

  return `${r.system}

## Environment
- Today: ${new Date().toDateString()} (${new Date().toISOString()})
- OS: ${PLATFORM.os} · shell: ${PLATFORM.shell} · home: ${PLATFORM.home}
- Working dir for shell + files: ${WORKSPACE}
- Project folder: ${project.root}${project.files.length ? ` (instructions: ${project.files.map((f) => f.name).join(', ')})` : ''}
- User: ${s.agent?.user || 'the owner of this PC'}${s.google.email ? ` (${s.google.email})` : ''}

## Available tools
${role === 'core' || r.tools === '*' ? toolHelp() : toolHelp()}

${PROTOCOL}

${project.text ? `## Project instructions (follow these)\n${project.text}\n` : ''}
${skillText ? `## Relevant skills for this task\n${skillText}\n` : enabled ? `## Available skills (call skill(name) to load one)\n${enabled}\n` : ''}
${memBlock ? `## Remembered notes\n${memBlock}\n` : ''}
${prof ? `## What you know about this person\n${prof}\n` : ''}
${knowledge ? `## Relevant things you learned before\n${knowledge}\n` : ''}
${extra ? `## Task context\n${extra}\n` : ''}`;
}

/**
 * Cloud models sometimes end a long tool call with one brace missing (observed: two '{', one '}').
 * Strict JSON.parse then fails and the call is thrown away, which looks exactly like "the file was
 * never created". Close the open braces, honouring strings so braces inside code are ignored.
 */
function repairJson(raw) {
  const s = String(raw).trim().replace(/,\s*$/, '');
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

function parseLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  try {
    return JSON.parse(repairJson(raw));
  } catch {}
  return null;
}

export function extractToolCall(text) {
  const fence = /```(?:tool|json|action)\s*([\s\S]*?)```/gi;
  let m;
  let found = null;
  while ((m = fence.exec(text))) {
    const raw = m[1].trim();
    const obj = parseLoose(raw) || parseLoose((raw.match(/\{[\s\S]*\}/) || [''])[0]);
    if (obj) {
      const name = obj.tool || obj.name || obj.action_name;
      if (name && typeof name === 'string') {
        found = { name, args: obj.args || obj.arguments || obj.parameters || {}, block: m[0] };
      }
    }
  }
  if (found) return found;

  // Models frequently emit the tool call as bare JSON with no fence at all. That used to be silently
  // treated as prose: the tool never ran, no file was written, and the next turn claimed success.
  // Accept a bare object only when it names a tool that actually exists.
  const known = new Set(Object.keys(TOOLS));
  const candidates = String(text).match(/\{[\s\S]*\}/g) || [];
  for (const raw of candidates.reverse()) {
    const obj = parseLoose(raw);
    if (!obj) continue;
    const name = obj.tool || obj.name;
    if (!name || !known.has(name)) continue;
    return { name, args: obj.args || obj.arguments || obj.parameters || {}, block: raw };
  }
  return null;
}

function trimHistory(messages, budget = 14) {
  const recent = messages.slice(Math.max(0, messages.length - budget));
  // Only the oldest slice gets compacted — recent tool output must always reach the model verbatim.
  const verbatimFrom = Math.max(0, recent.length - 8);
  return recent.map((m, idx) => {
    const old = idx < verbatimFrom;
    if (old && m.role === 'user' && String(m.content).startsWith('TOOL RESULT')) {
      return { role: 'user', content: '[earlier tool result elided to save context]' };
    }
    if (m.role === 'user') return { ...m, content: truncate(m.content, old ? 1500 : 6000) };
    if (m.role === 'assistant') return { ...m, content: truncate(m.content, old ? 1500 : 6000) };
    return m;
  });
}

/**
 * One agent turn loop. Streams events through emit(type, payload).
 * Returns { answer, steps, messages }.
 */
export async function runAgent({ role = 'core', input, messages, depth = 0, emit = () => {}, signal, maxSteps, policyMode, systemOverlay, onCheckpoint } = {}) {
  const s = settings();
  const steps = Math.min(Number(maxSteps) || s.maxSteps || 14, depth > 0 ? 8 : 20);
  const convo = messages ? [...messages] : [{ role: 'user', content: input }];
  const transcript = [];
  const checkpoint = () => onCheckpoint?.(convo.map((m) => ({ role: m.role, content: m.content })));
  // Build the system prompt once per run: it embeds brain context and skills, and rebuilding it on
  // every step was both slow and a source of prompt drift mid-task.
  let sysPrompt = systemPrompt({ role, query: String(input || messages?.at(-1)?.content || '').slice(0, 800) });
  // Spatial workspace overlay (goal-bound cognitive desktop)
  try {
    const { activeOverlay } = await import('./workspaces.js');
    const wsOverlay = activeOverlay();
    if (wsOverlay) sysPrompt = `${sysPrompt}\n\n# Active workspace\n${wsOverlay}`;
  } catch {}
  if (systemOverlay) sysPrompt = `${sysPrompt}\n\n# Recipe / session overlay\n${systemOverlay}`;
  const budget = {
    maxToolCalls: Number(s.policy?.maxToolCallsPerRun) || 30,
    deadline: Date.now() + (Number(s.policy?.runWallClockSec) || 900) * 1000,
    toolCalls: 0,
    promptTokensEst: 0,
    completionTokensEst: 0,
  };
  // Simple action-loop detector (Browser-Use style): hash of recent tool calls.
  const recentHashes = [];
  const MAX_REPEAT = 3;

  for (let step = 0; step < steps; step++) {
    if (signal?.aborted) {
      emit('error', { message: 'Stopped.' });
      checkpoint();
      return { role, answer: '', steps: transcript, messages: convo, error: 'stopped' };
    }
    if (Date.now() > budget.deadline) {
      const msg = 'Stopped: this run hit its wall-clock budget. Ask me to continue and I will resume from here.';
      emit('budget', { reason: 'wall-clock', seconds: Math.round((Date.now() - (budget.deadline - (Number(s.policy?.runWallClockSec) || 900) * 1000)) / 1000) });
      emit('answer', { text: msg });
      convo.push({ role: 'assistant', content: msg });
      checkpoint();
      return { role, answer: msg, steps: transcript, messages: convo, incomplete: true };
    }
    if (budget.toolCalls >= budget.maxToolCalls) {
      const msg = `Stopped: tool-call budget reached (${budget.maxToolCalls}). Raise it in Safety settings or ask me to continue.`;
      emit('budget', { reason: 'tool-calls', limit: budget.maxToolCalls });
      emit('answer', { text: msg });
      convo.push({ role: 'assistant', content: msg });
      checkpoint();
      return { role, answer: msg, steps: transcript, messages: convo, incomplete: true };
    }
    let buf = '';
    emit('phase', { step: step + 1, of: steps, role });
    try {
      const stream = chatStream(
        [
          { role: 'system', content: sysPrompt },
          ...trimHistory(convo),
        ],
        { signal, onProvider: info => emit('provider', info) },
      );
      for await (const piece of stream) {
        if (signal?.aborted) break;
        buf += piece;
        emit('delta', { text: piece, step: step + 1 });
      }
      if (signal?.aborted) {
        emit('error', { message: 'Stopped.' });
        checkpoint();
        return { role, answer: '', steps: transcript, messages: convo, error: 'stopped' };
      }
    } catch (e) {
      const msg = e instanceof LLMError ? e.message : String(e.message || e);
      emit('error', { message: msg });
      checkpoint();
      return { role, answer: '', steps: transcript, messages: convo, error: msg };
    }

    if (!buf.trim()) {
      const msg = 'The model returned an empty response. Try a smaller prompt or a different model.';
      emit('error', { message: msg });
      checkpoint();
      return { role, answer: '', steps: transcript, messages: convo, error: msg };
    }

    const call = extractToolCall(buf);
    if (!call) {
      let answer = buf.trim();
      // A claim of "done" is only true if the file exists. Verify before it reaches the user.
      const v = preview.verifyClaims(answer);
      const produced = preview.recentArtifacts({ minutes: 25 });
      if (v.missing.length) {
        answer +=
          `\n\n⚠ **Not on disk:** ${v.missing.map((m) => m.path).join(', ')}\n` +
          'The work probably did not complete. Check the job log in **Lab** before trusting this answer.';
      }
      emit('artifacts', { produced: produced.slice(0, 12), claimed: v.claimed, missing: v.missing });
      const meter = telemetry.estimate({
        model: settings().model,
        promptText: sysPrompt + JSON.stringify(convo).slice(0, 200000),
        completionText: answer,
        steps: Math.max(1, budget.toolCalls + 1),
      });
      telemetry.addRun(meter);
      emit('usage', meter);
      emit('answer', { text: answer });
      convo.push({ role: 'assistant', content: answer });
      checkpoint();
      return { role, answer, steps: transcript, messages: convo };
    }

    const cleanText = buf.replace(call.block, '').trim();
    if (cleanText) emit('narrative', { text: cleanText });
    const callId = uid('tc_');
    budget.toolCalls++;

    // Loop detector: identical tool+args repeating → stop and ask
    const actionHash = `${call.name}:${JSON.stringify(call.args || {}).slice(0, 400)}`;
    recentHashes.push(actionHash);
    if (recentHashes.length > 12) recentHashes.shift();
    const repeats = recentHashes.filter((h) => h === actionHash).length;
    if (repeats >= MAX_REPEAT) {
      const msg =
        `Stopped: detected a repeated action loop (${call.name} ×${repeats}). ` +
        'Change strategy or tell me a different approach.';
      emit('budget', { reason: 'action-loop', tool: call.name, repeats });
      emit('answer', { text: msg });
      convo.push({ role: 'assistant', content: msg });
      checkpoint();
      return { role, answer: msg, steps: transcript, messages: convo, error: 'action-loop' };
    }

    emit('tool_start', { callId, name: call.name, args: call.args });
    const started = Date.now();
    const result = await runTool(call.name, call.args, { depth, emit, signal, policyMode });
    const ms = Date.now() - started;
    transcript.push({ callId, name: call.name, args: call.args, ms, ok: result?.ok !== false });
    emit('tool_end', { callId, name: call.name, ms, ok: result?.ok !== false, preview: truncate(JSON.stringify(result), 700) });

    // rough cost tracking (chars → tokens estimate)
    budget.completionTokensEst += Math.ceil((buf.length + JSON.stringify(result).length) / 4);

    convo.push({ role: 'assistant', content: cleanText ? `${cleanText}\n\n${call.block}` : call.block });
    convo.push({
      role: 'user',
      content: `TOOL RESULT (${call.name}) — ${JSON.stringify(result).slice(0, 6000)}\n\nContinue. Call another tool if needed, otherwise give the final answer.`,
    });
    checkpoint();
  }

  const note =
    'Reached the step limit. Here is what I found so far — tell me to continue and I will pick up from here.';
  emit('answer', { text: note });
  convo.push({ role: 'assistant', content: note });
  checkpoint();
  return { role, answer: note, steps: transcript, messages: convo, incomplete: true };
}

/** Run several roles on the same brief in parallel, then synthesise. */
export async function runCluster({ brief, roles: roleIds, emit = () => {}, signal }) {
  const ids = (roleIds && roleIds.length ? roleIds : ['researcher', 'analyst', 'critic']).filter((r) => roles()[r]);
  emit('cluster_start', { roles: ids });
  const results = await Promise.all(
    ids.map(async (id) => {
      const sub = (type, payload) => emit('cluster_child', { role: id, type, ...payload });
      const r = await runAgent({ role: id, input: brief, depth: 1, emit: sub, signal, maxSteps: 8 });
      emit('cluster_done', { role: id, answer: truncate(r.answer, 1200) });
      return { role: id, name: roles()[id].name, answer: r.answer, steps: r.steps };
    }),
  );

  const synthInput = `Brief:\n${brief}\n\n${results
    .map((r) => `## ${r.name} (${r.role})\n${truncate(r.answer, 3000)}`)
    .join('\n\n')}\n\nSynthesise these into one final answer for the user. Resolve contradictions explicitly, drop anything unsupported, keep it tight. No tool block.`;

  emit('phase', { step: 1, of: 1, role: 'core', synthesising: true });
  let final = '';
  try {
    const stream = chatStream(
      [
        { role: 'system', content: systemPrompt({ role: 'core' }) },
        { role: 'user', content: synthInput },
      ],
      { signal: undefined, onProvider: info => emit('provider', info) },
    );
    for await (const piece of stream) {
      final += piece;
      emit('delta', { text: piece, step: 'synth' });
    }
  } catch (e) {
    final = results.map((r) => `### ${r.name}\n${r.answer}`).join('\n\n');
  }
  const clean = final.replace(/```tool[\s\S]*?```/g, '').trim();
  emit('answer', { text: clean });
  return { answer: clean, results };
}
