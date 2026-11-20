// Vault + backup contract test over the real HTTP API.
import fs from 'node:fs';
import path from 'node:path';

const base = 'http://127.0.0.1:8787';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (p) => (await fetch(base + p)).json();

let pass = 0,
  fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// clean slate
const vaultFile = path.resolve('data/vault.json');
if (fs.existsSync(vaultFile)) fs.unlinkSync(vaultFile);

const SECRET = 'Tr0ub4dor&3-very-unique-test-value';
const PASSPHRASE = 'correct horse battery staple';

check('starts empty', (await get('/api/vault')).exists, false);
check('create rejects short passphrase', (await post('/api/vault', { action: 'create', passphrase: 'abc' })).ok, false);

const created = await post('/api/vault', { action: 'create', passphrase: PASSPHRASE });
check('create ok', created.ok, true);
check('unlocked after create', created.unlocked, true);

const added = await post('/api/vault', { action: 'add', entry: { service: 'Discord', username: 'me@example.com', password: SECRET, url: 'https://discord.com/login', tags: ['social'] } });
check('entry added', added.ok, true);
check('entry listed', added.items.length, 1);
check('password masked in list', added.items[0].passwordMasked, '••••••••');
check('list does not leak password', JSON.stringify(added.items).includes(SECRET), false);

const revealed = await post('/api/vault', { action: 'reveal', id: added.entry.id });
check('reveal returns password', revealed.entry.password, SECRET);

const gen = await post('/api/vault', { action: 'generate', options: { length: 24 } });
check('generator length', gen.password.length, 24);

check('lock ok', (await post('/api/vault', { action: 'lock' })).unlocked, false);
const lockedList = await get('/api/vault');
check('locked list empty', lockedList.items.length, 0);
check('reveal while locked fails', (await post('/api/vault', { action: 'reveal', id: added.entry.id })).ok, false);
check('wrong passphrase rejected', (await post('/api/vault', { action: 'unlock', passphrase: 'wrong passphrase' })).ok, false);
check('unlock works', (await post('/api/vault', { action: 'unlock', passphrase: PASSPHRASE })).ok, true);

// on-disk file must be ciphertext only
const rawVault = fs.readFileSync(vaultFile, 'utf8');
check('disk file has no plaintext password', rawVault.includes(SECRET), false);
check('disk file has no plaintext username', rawVault.includes('me@example.com'), false);

// backup must be encrypted and must not leak the secret
const bk = await post('/api/backup', { upload: false, note: 'test' });
check('backup ok', bk.ok, true);
check('backup written locally', Boolean(bk.local?.name), true);
const rawBackup = fs.readFileSync(path.join('data', 'backups', bk.local.name), 'utf8');
check('backup has no plaintext password', rawBackup.includes(SECRET), false);
check('backup has no plaintext username', rawBackup.includes('me@example.com'), false);
check('backup is sealed', JSON.parse(rawBackup).app, 'nexus-backup');

// backup refuses while locked
await post('/api/vault', { action: 'lock' });
check('backup blocked when locked', (await post('/api/backup', { upload: false })).ok, false);
await post('/api/vault', { action: 'unlock', passphrase: PASSPHRASE });

// state must not leak the vault key or entries
const st = await get('/api/state');
check('state reports vault status only', typeof st.vault.unlocked, 'boolean');
check('state has no vault items', JSON.stringify(st).includes('me@example.com'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
