import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('missions persist checkpoints, require review for uncertain actions, and learn from feedback', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-test-'));
  process.env.NEXUS_DATA_DIR = data;
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));

  const missions = await import('../lib/missions.js');
  const policy = await import('../lib/policy.js');

  const mission = missions.create({ goal: 'Build and verify a small project' });
  assert.equal(mission.status, 'ready');
  assert.equal(Object.hasOwn(mission, 'messages'), false);
  assert.equal(missions.list()[0].nodes, undefined);

  missions.start(mission.id);
  missions.recordEvent(mission.id, 'tool_start', {
    callId: 'call-1',
    name: 'files',
    args: { action: 'read', path: 'src/index.js', apiKey: 'not-for-history' },
  });
  missions.recordEvent(mission.id, 'tool_end', {
    callId: 'call-1',
    ok: true,
    ms: 14,
    preview: '{"ok":true}',
  });
  missions.checkpoint(mission.id, [
    { role: 'user', content: 'Build and verify a small project' },
    { role: 'assistant', content: 'I inspected the project.' },
  ]);
  let detail = missions.get(mission.id);
  assert.equal(detail.nodes.find((node) => node.callId === 'call-1').status, 'succeeded');
  assert.match(detail.nodes.find((node) => node.callId === 'call-1').detail, /redacted/);
  assert.equal(missions.forRun(mission.id).messages.length, 2);

  missions.recordEvent(mission.id, 'answer', { text: 'Verified.' });
  missions.finish(mission.id, { status: 'completed', answer: 'Verified.' });
  missions.feedback(mission.id, { rating: 5, note: 'Keep the focused tests before edits.' });
  assert.deepEqual(missions.lessons(2).map((lesson) => lesson.kind), ['keep']);
  assert.equal(missions.get(mission.id).feedback.rating, 5);

  const interrupted = missions.create({ goal: 'Inspect an interrupted tool action' });
  missions.start(interrupted.id);
  missions.recordEvent(interrupted.id, 'tool_start', {
    callId: 'call-2',
    name: 'shell',
    args: { command: 'python train.py' },
  });
  missions.recoverInterrupted();
  assert.equal(missions.get(interrupted.id).status, 'needs_review');
  assert.throws(() => missions.start(interrupted.id), /unknown outcome/);
  missions.start(interrupted.id, { acknowledgeRisk: true });

  const controller = new AbortController();
  const approval = policy.requestApproval(
    { tool: 'shell', args: { command: 'run tests' }, reason: 'needs approval', risk: { risk: 'exec' }, summary: 'run tests' },
    undefined,
    { signal: controller.signal },
  );
  assert.equal(policy.pendingApprovals().length, 1);
  controller.abort();
  assert.equal((await approval).decision, 'deny');
  assert.equal(policy.pendingApprovals().length, 0);
});
