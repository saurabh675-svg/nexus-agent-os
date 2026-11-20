import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT, settings } from '../lib/config.js';

const checks = [];
const report = (name, ok, detail) => checks.push({ name, ok, detail });
const nodeMajor = Number(process.versions.node.split('.')[0]);

report('Node.js', nodeMajor >= 20, `v${process.versions.node}${nodeMajor < 20 ? ' — install Node.js 20 or newer' : ''}`);
report('Nexus server', fs.existsSync(path.join(ROOT, 'server.js')), 'server.js');
report('Web interface', fs.existsSync(path.join(ROOT, 'public', 'index.html')), 'public/index.html');
try {
  fs.accessSync(DATA, fs.constants.W_OK);
  report('Runtime data', true, DATA);
} catch (error) {
  report('Runtime data', false, `${DATA}: ${error.message}`);
}

const current = settings();
const providerCount = Array.isArray(current.providers) ? current.providers.length : 0;
const activeModel = current.model || current.openai?.model || '(not configured)';
report('Model name configured', Boolean(activeModel && activeModel !== '(not configured)'), `${providerCount} provider profile(s); selected model: ${activeModel}. This does not verify that it is installed or reachable.`);
report('Remote failover policy', true, current.routing?.allowRemoteFallback === true
  ? 'Enabled; prompts may be sent to another configured provider.'
  : 'Off by default; requests will not silently fall back to a remote provider.');
report('Local fallback policy', true, current.routing?.localFallbackEnabled === true
  ? 'Enabled; failed requests may be retried through local Ollama.'
  : 'Off by default; requests use only the selected provider.');

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
}
console.log(`\n${checks.filter((item) => item.ok).length}/${checks.length} checks passed.`);
if (checks.some((item) => !item.ok)) process.exitCode = 1;
