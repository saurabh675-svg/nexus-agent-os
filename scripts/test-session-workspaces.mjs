import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const previousDataDir = process.env.NEXUS_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-workspace-test-'));
process.env.NEXUS_DATA_DIR = dataDir;

const workspaces = await import('../lib/workspaces.js');
const sessions = await import('../lib/sessions.js');

after(async () => {
  if (previousDataDir === undefined) delete process.env.NEXUS_DATA_DIR;
  else process.env.NEXUS_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('existing workspace settings gain the Business workspace without losing custom settings', async () => {
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      activeId: 'custom',
      workspaces: [
        { id: 'default', name: 'My General', goal: 'Keep my setting' },
        { id: 'custom', name: 'Custom', goal: 'Custom workspace' },
      ],
    }),
  );

  const state = workspaces.list();
  assert.equal(state.activeId, 'custom');
  assert.equal(state.workspaces.find((item) => item.id === 'default').name, 'My General');
  assert.ok(state.workspaces.some((item) => item.id === 'kaggle'));
  assert.ok(state.workspaces.some((item) => item.id === 'business'));
  assert.ok(state.workspaces.some((item) => item.id === 'custom'));
});

test('chat sessions are filtered by workspace and cannot be moved across workspaces', () => {
  const general = sessions.save({ workspaceId: 'default', messages: [{ role: 'user', content: 'Hello' }] });
  const kaggle = sessions.save({ workspaceId: 'kaggle', messages: [{ role: 'user', content: 'Competition rules' }] });

  assert.deepEqual(sessions.list(40, 'default').map((item) => item.id), [general.id]);
  assert.deepEqual(sessions.list(40, 'kaggle').map((item) => item.id), [kaggle.id]);
  assert.equal(sessions.load(kaggle.id).workspaceId, 'kaggle');
  assert.throws(
    () => sessions.save({ id: kaggle.id, workspaceId: 'business', messages: [] }),
    /cannot move a chat session between workspaces/,
  );
});
