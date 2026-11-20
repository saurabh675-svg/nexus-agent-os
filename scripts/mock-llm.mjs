// Mock OpenAI-compatible endpoint: proves the agent loop, tool parsing and streaming without a real model.
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) =>
  new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
  });

http
  .createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    }
    const payload = JSON.parse((await readBody(req)) || '{}');
    const msgs = payload.messages || [];
    const system = String(msgs[0]?.content || '');
    const lastUser = String([...msgs].reverse().find((m) => m.role === 'user')?.content || '');
    const sawToolResult = msgs.some((m) => String(m.content).startsWith('TOOL RESULT'));
    const isChild = /^You are a research sub-agent/i.test(system.slice(0, 120));
    const isSynth = /Synthesise these into one final answer/i.test(lastUser);
    const wantsShell = msgs.some((m) => String(m.content).includes('run-shell'));

    let text;
    if (isSynth) {
      text = '# Synthesis\n\nAll three sub-agents agreed: **Kaggle API access works**, and the fastest baseline is a small tabular model.\n\n- researcher found 3 sources\n- analyst flagged GPU quota\n- critic asked for a local repro\n';
    } else if (wantsShell && !sawToolResult) {
      text = 'I need to run a command for that.\n\n```tool\n{"tool":"shell","args":{"command":"echo nexus-gate-ok"}}\n```\n';
    } else if (wantsShell && sawToolResult) {
      text = 'Command approved and executed. The shell returned `nexus-gate-ok`, so the gate works end to end.';
    } else if (!sawToolResult && !isChild) {
      text =
        'Checking the live web first.\n\n```tool\n{"tool":"web_search","args":{"query":"kaggle competition deadline 2026"}}\n```\n';
    } else if (!sawToolResult && isChild) {
      text = 'Gathering sources.\n\n```tool\n{"tool":"open_page","args":{"url":"https://www.kaggle.com/competitions"}}\n```\n';
    } else if (isChild) {
      text = '**Researcher finding:** three live competitions; the nearest deadline is in 11 days. Source: kaggle.com/competitions.';
    } else {
      text = 'Done. I searched the web and the API returned results.\n\n- tool executed successfully\n- streaming works\n- the loop terminated normally';
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const piece of text.match(/[\s\S]{1,14}/g) || []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(4);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  })
  .listen(9911, '127.0.0.1', () => console.log('mock llm on http://127.0.0.1:9911/v1'));
