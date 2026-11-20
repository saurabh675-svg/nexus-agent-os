import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const originalDataDir = process.env.NEXUS_DATA_DIR;
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-browser-test-'));
process.env.NEXUS_DATA_DIR = fixture;
const webbrowser = await import('../lib/webbrowser.js');
const cdpBrowser = await import('../lib/browser.js');
const secret = 'fixture-password-must-not-leak';
let submits = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST') submits++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<form action="/submit" method="post"><input type="password" name="password" value="server-side-secret"><button type="submit">Sign in</button></form>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

after(async () => {
  webbrowser.closeAll();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('nexus-browser-test-')) {
    throw new Error('Unsafe test fixture path');
  }
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalDataDir === undefined) delete process.env.NEXUS_DATA_DIR;
  else process.env.NEXUS_DATA_DIR = originalDataDir;
});

test('password inputs stay redacted in built-in snapshots and typing results', async () => {
  const opened = await webbrowser.open(url);
  const initial = webbrowser.snapshot({ tabId: opened.id });
  const password = initial.items.find((item) => item.type === 'password');
  assert.ok(password);
  assert.equal(password.value, '');
  assert.equal(password.label.includes('server-side-secret'), false);

  const typed = await webbrowser.type({ index: password.i, text: secret, tabId: opened.id });
  assert.equal(JSON.stringify(typed).includes(secret), false);
  assert.equal(JSON.stringify(webbrowser.snapshot({ tabId: opened.id })).includes(secret), false);
});

test('unsupported keys fail instead of silently pressing Enter', async () => {
  await assert.rejects(cdpBrowser.press({ key: 'DefinitelyNotAKey' }), /unsupported browser key/);
  await assert.rejects(webbrowser.press({ key: 'DefinitelyNotAKey' }), /only supports Enter/);
  assert.equal(submits, 0);
});
