// Verifies the exact failure mode: tool calls emitted as bare JSON, with no ```tool fence.
// Run from the app folder: node scripts/test-parse.mjs
import { extractToolCall } from '../lib/agentloop.js';

const cases = [
  {
    name: 'bare JSON (what failed 5 times)',
    input: 'I will build it now.\n\n{"tool":"runtime","args":{"action":"run","code":"from pptx import Presentation"}}',
    expect: 'runtime',
  },
  {
    name: 'fenced tool block',
    input: 'text\n\n```tool\n{"tool":"web_search","args":{"query":"x"}}\n```',
    expect: 'web_search',
  },
  {
    name: 'prose with unrelated JSON (must be ignored)',
    input: 'Here is a JSON example: {"name":"something","value":42}',
    expect: null,
  },
  {
    name: 'prose with unknown tool name (must be ignored)',
    input: '{"tool":"delete_everything","args":{}}',
    expect: null,
  },
  {
    name: 'tool name in a fenced json block',
    input: '```json\n{"name":"files","arguments":{"action":"read","path":"a.txt"}}\n```',
    expect: 'files',
  },
  {
    name: 'bare JSON with a MISSING closing brace (your real failure)',
    input:
      'I will build it.\n\n{"tool":"runtime","args":{"action":"run","code":"print(1)","lang":"python"}\r\n',
    expect: 'runtime',
  },
  {
    name: 'bare JSON where braces appear inside the code string',
    input: 'Text\n\n{"tool":"runtime","args":{"code":"d = {1: 2}"}}',
    expect: 'runtime',
  },
];

let pass = 0;
for (const c of cases) {
  const got = extractToolCall(c.input);
  const name = got ? got.name : null;
  const ok = name === c.expect;
  pass += ok ? 1 : 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${name}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
