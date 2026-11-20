// Diagnose why the live parser fails on a real model reply.
import fs from 'node:fs';
import { extractToolCall } from '../lib/agentloop.js';

const t = fs.readFileSync(process.env.TEMP + '\\model-text.txt', 'utf8');
console.log('length:', t.length);
console.log('first 120:', JSON.stringify(t.slice(0, 120)));
console.log('last 200:', JSON.stringify(t.slice(-200)));
console.log('has fence:', /```/.test(t));
console.log('brace counts: { =', (t.match(/\{/g) || []).length, '} =', (t.match(/\}/g) || []).length);
console.log('"tool" occurrences:', (t.match(/"tool"/g) || []).length);

const greedy = t.match(/\{[\s\S]*\}/g) || [];
console.log('greedy candidates:', greedy.length, 'first len:', greedy[0] ? greedy[0].length : 0);
if (greedy[0]) {
  try {
    JSON.parse(greedy[0]);
    console.log('greedy parse: OK');
  } catch (e) {
    console.log('greedy parse FAILED:', e.message.slice(0, 100));
    console.log('  head:', JSON.stringify(greedy[0].slice(0, 80)));
    console.log('  tail:', JSON.stringify(greedy[0].slice(-80)));
  }
}

console.log('extractToolCall ->', extractToolCall(t) ? extractToolCall(t).name : 'NULL');

// Try a balanced-brace scan: for each '{' that starts a tool object, find its matching '}'.
function balancedObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

const objs = balancedObjects(t);
console.log('balanced objects found:', objs.length);
for (const o of objs) {
  try {
    const parsed = JSON.parse(o);
    const name = parsed.tool || parsed.name;
    if (name) console.log('  -> parses, name =', name, 'len', o.length);
  } catch {
    /* not JSON */
  }
}
