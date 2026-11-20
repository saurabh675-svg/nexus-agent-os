// Unit test for the permission engine: mode matrix, rules, destructive block, approval flow, checkpoints.
import fs from 'node:fs';
import path from 'node:path';
import * as policy from '../lib/policy.js';
import { saveSettings, settings, WORKSPACE, DATA } from '../lib/config.js';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

const setMode = (mode) => policy.updatePolicy({ mode, rules: [] });

// --- mode matrix -----------------------------------------------------------
setMode('plan');
check('plan: shell is denied', policy.decide('shell', { command: 'dir' }).decision, 'deny');
check('plan: web_search allowed', policy.decide('web_search', { query: 'x' }).decision, 'allow');
check('plan: file write denied', policy.decide('files', { action: 'write', path: 'a.txt' }).decision, 'deny');

setMode('ask');
check('ask: read allowed', policy.decide('files', { action: 'read', path: 'a.txt' }).decision, 'allow');
check('ask: write asks', policy.decide('files', { action: 'write', path: 'a.txt' }).decision, 'ask');
check('ask: shell asks', policy.decide('shell', { command: 'python -V' }).decision, 'ask');
check('ask: gmail send asks', policy.decide('gmail', { action: 'send', to: 'a@b.c' }).decision, 'ask');

setMode('auto');
check('auto: write in workspace allowed', policy.decide('files', { action: 'write', path: 'notes.txt' }).decision, 'allow');
check('auto: write outside asks', policy.decide('files', { action: 'write', path: 'C:\\Windows\\x.txt' }).decision, 'ask');
check('auto: shell still asks', policy.decide('shell', { command: 'dir' }).decision, 'ask');

setMode('full');
check('full: shell allowed', policy.decide('shell', { command: 'npm test' }).decision, 'allow');
check('full: destructive still denied', policy.decide('files', { action: 'delete', path: 'x' }).decision, 'deny');
check('full: format-volume denied by classifier', policy.decide('shell', { command: 'Format-Volume -DriveLetter C' }).risk.risk, 'exec');

// --- rules -----------------------------------------------------------------
setMode('ask');
policy.addRule('shell:git *', 'allow');
check('rule: git allowed', policy.decide('shell', { command: 'git status' }).decision, 'allow');
check('rule: other shell still asks', policy.decide('shell', { command: 'del x' }).decision, 'ask');
policy.addRule('shell:*', 'deny');
check('rule: explicit deny wins', policy.decide('shell', { command: 'git status' }).decision, 'deny');
policy.updatePolicy({ rules: [] });

// --- approval flow (gate) --------------------------------------------------
setMode('ask');
const events = [];
let approvalId = null;
const gatePromise = policy
  .gate('shell', { command: 'echo hello' }, {
    emit: (type, payload) => {
      events.push(type);
      if (type === 'approval') approvalId = payload.id;
    },
  })
  .then((r) => r);

await new Promise((r) => setTimeout(r, 120));
check('gate emitted approval', events.includes('approval'), true);
check('gate has a real id', Boolean(approvalId && approvalId.startsWith('ap_')), true);
policy.resolveApproval(approvalId, 'allow', 'once');
const gateResult = await gatePromise;
check('gate allowed after approval', gateResult.allow, true);

// deny path
const events2 = [];
let id2 = null;
const p2 = policy.gate('shell', { command: 'echo nope' }, { emit: (t, d) => t === 'approval' && (id2 = d.id) }).then((r) => r);
await new Promise((r) => setTimeout(r, 120));
policy.resolveApproval(id2, 'deny', 'once');
check('gate denies when user denies', (await p2).allow, false);

// --- audit & checkpoints ---------------------------------------------------
const entries = policy.readAudit(20);
check('audit logged entries', entries.length > 0, true);
check('audit has a deny record', entries.some((e) => e.decision === 'deny'), true);

const target = path.join(WORKSPACE, 'checkpoint-test.txt');
fs.writeFileSync(target, 'original content', 'utf8');
const backup = policy.checkpoint(target);
fs.writeFileSync(target, 'clobbered', 'utf8');
check('checkpoint created', Boolean(backup), true);
policy.restoreCheckpoint(backup);
check('restore recovered content', fs.readFileSync(target, 'utf8'), 'original content');
fs.unlinkSync(target);

// --- MCP tools are treated as exec -----------------------------------------
check('mcp tool requires approval', policy.decide('mcp__github__create_issue', { title: 'x' }).decision, 'ask');

setMode('ask');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
