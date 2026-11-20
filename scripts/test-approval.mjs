// End-to-end: agent wants to run a shell command, the policy gate asks, we approve over HTTP,
// the command executes, and the loop continues. Proves the approval round-trip through SSE.
const msg = 'run-shell please';
const body = { input: msg, messages: [{ role: 'user', content: msg }], mode: 'agent', role: 'core' };

const res = await fetch('http://127.0.0.1:8787/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let approved = null;
let answer = '';
let sawToolEnd = false;
let approvalCount = 0;

const handle = async (ev, d) => {
  if (ev === 'approval') {
    approvalCount++;
    console.log(`  approval requested: ${d.tool} · ${d.summary} (risk=${d.risk}, id=${d.id})`);
    const r = await fetch('http://127.0.0.1:8787/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: d.id, decision: 'allow', scope: 'once' }),
    }).then((x) => x.json());
    approved = r.ok;
    console.log(`  approval posted: ok=${r.ok}`);
  } else if (ev === 'tool_end') {
    sawToolEnd = true;
    console.log(`  tool_end: ${d.name} ok=${d.ok} ${d.ms}ms`);
    console.log(`  preview: ${String(d.preview || '').slice(0, 160)}`);
  } else if (ev === 'answer') {
    answer = d.text;
  } else if (ev === 'error') {
    console.log(`  ERROR: ${d.message}`);
  }
};

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
    try {
      await handle(ev, JSON.parse(data || '{}'));
    } catch {}
  }
}

console.log('\nRESULT');
console.log('  approvals:', approvalCount);
console.log('  approved:', approved);
console.log('  tool executed:', sawToolEnd);
console.log('  answer:', String(answer).slice(0, 140));
const ok = approvalCount === 1 && approved === true && sawToolEnd === true && /gate works/i.test(answer);
console.log(ok ? '\nPASS  approval → execution → answer' : '\nFAIL');
process.exit(ok ? 0 : 1);
