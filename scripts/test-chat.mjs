// Drives /api/chat against the mock LLM and prints the SSE event timeline.
const payload = { input: 'find the nearest kaggle deadline', messages: [{ role: 'user', content: 'find the nearest kaggle deadline' }], mode: 'agent', role: 'core' };

const res = await fetch('http://127.0.0.1:8787/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
if (!res.body) {
  console.log('no body', res.status);
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const seen = [];
let deltas = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) ev = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    let d = {};
    try {
      d = JSON.parse(data || '{}');
    } catch {}
    if (ev === 'delta') {
      deltas++;
      continue;
    }
    seen.push(ev);
    if (ev === 'tool_start') console.log(`  tool_start  ${d.name} ${JSON.stringify(d.args)}`);
    else if (ev === 'tool_end') console.log(`  tool_end    ${d.name} ok=${d.ok} ${d.ms}ms`);
    else if (ev === 'answer') console.log(`  answer      ${String(d.text).slice(0, 120).replace(/\n/g, ' / ')}`);
    else if (ev === 'error') console.log(`  ERROR       ${d.message}`);
    else if (ev === 'done') console.log('  done');
  }
}
console.log('events:', seen.join(' → '), `| deltas: ${deltas}`);
process.exit(0);
