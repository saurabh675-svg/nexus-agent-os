import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const tempParent = path.resolve(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(tempParent, 'nexus-vision-test-'));
await fs.mkdir(path.join(fixture, 'lib'));
await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
for (const file of ['vision.js', 'browser.js', 'providers.js', 'config.js', 'util.js', 'vault.js', 'model-secrets.js']) {
  await fs.copyFile(new URL('../lib/' + file, import.meta.url), path.join(fixture, 'lib', file));
}

const config = await import(pathToFileURL(path.join(fixture, 'lib', 'config.js')));
const vision = await import(pathToFileURL(path.join(fixture, 'lib', 'vision.js')));
const vault = await import(pathToFileURL(path.join(fixture, 'lib', 'vault.js')));
const savedFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = savedFetch;
  if (path.dirname(fixture) !== tempParent || !path.basename(fixture).startsWith('nexus-vision-test-')) {
    throw new Error('Unsafe fixture path');
  }
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('local vision sends images to the configured Ollama server without cloud credentials', async () => {
  config.saveSettings({
    visionProviderId: 'ollama',
    visionModel: 'qwen3-vl:4b',
    ollamaUrl: 'http://127.0.0.1:11434',
    providers: [],
  });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({ response: 'The button is visible.' });
  };
  const result = await vision.askVision({ images: ['YWJj'], prompt: 'Find the button.' });
  assert.equal(request.url, 'http://127.0.0.1:11434/api/generate');
  assert.deepEqual(JSON.parse(request.options.body).images, ['YWJj']);
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(result.text, 'The button is visible.');
  assert.equal(result.provider, 'Ollama local');
});

test('explicit image-capable API provider receives an OpenAI-compatible image request', async () => {
  config.saveSettings({
    visionProviderId: 'remote-vision',
    providers: [{
      id: 'remote-vision',
      label: 'Vision API',
      kind: 'openai',
      baseUrl: 'https://vision.example/v1',
      model: 'vision-model',
      apiKey: 'fixture-secret',
      supportsVision: true,
    }],
  });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ message: { content: 'Found the button.' } }] });
  };
  const result = await vision.askVision({ images: ['YWJj'], prompt: 'Find the button.' });
  assert.equal(request.url, 'https://vision.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer fixture-secret');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,YWJj' },
  });
  assert.equal(result.text, 'Found the button.');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('vision providers resolve encrypted keys from the unlocked Vault', async () => {
  const passphrase = 'vision fixture vault passphrase';
  vault.create(passphrase);
  const secret = 'encrypted-vision-fixture-key';
  const entry = vault.add({ service: 'Vision API', password: secret });
  config.saveSettings({
    visionProviderId: 'vault-vision',
    providers: [{
      id: 'vault-vision',
      label: 'Vault vision API',
      kind: 'openai',
      baseUrl: 'https://vision.example/v1',
      model: 'vision-model',
      secretId: entry.id,
      supportsVision: true,
    }],
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://vision.example/v1/chat/completions');
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    return Response.json({ choices: [{ message: { content: 'Vault key works.' } }] });
  };
  assert.equal((await vision.askVision({ images: ['YWJj'], prompt: 'Check the image.' })).text, 'Vault key works.');
  vault.lock();
  await assert.rejects(vision.askVision({ images: ['YWJj'], prompt: 'Check the image.' }), /legacy Vault key/);
  vault.unlock(passphrase);
});

test('remote screenshots are rejected unless the selected profile is marked image-capable', async () => {
  config.saveSettings({
    visionProviderId: 'text-only',
    providers: [{
      id: 'text-only',
      label: 'Text API',
      kind: 'openai',
      baseUrl: 'https://text.example/v1',
      model: 'text-model',
      apiKey: 'fixture-secret',
      supportsVision: false,
    }],
  });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({});
  };
  await assert.rejects(vision.askVision({ images: ['YWJj'], prompt: 'Find the button.' }), /not marked as image-capable/);
  assert.equal(called, false);
});
