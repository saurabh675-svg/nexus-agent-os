import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, ROOT } from './config.js';
import { ensureDir, uid, truncate } from './util.js';

/**
 * Uploads: files the user drops into chat.
 *
 * Text is extracted so the model can actually read the file instead of guessing from the name.
 * Office formats and PDFs go through scripts/extract.py (Python stdlib + pypdf if present) because
 * writing a docx/pptx/xlsx/PDF parser in Node with no dependencies is not a good trade.
 */

export const UPLOAD_DIR = path.join(DATA, 'uploads');
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs',
  '.rb', '.php', '.sh', '.ps1', '.bat', '.sql', '.ipynb', '.toml', '.ini', '.cfg', '.log', '.r', '.m',
]);
const OFFICE_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function safeName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

function run(cmd, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

async function extractText(file, ext) {
  if (TEXT_EXT.has(ext)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return { kind: 'text', text: truncate(raw, 20000), chars: raw.length };
    } catch (e) {
      return { kind: 'text', text: '', error: e.message };
    }
  }
  if (OFFICE_EXT.has(ext) || IMAGE_EXT.has(ext)) {
    const py = path.join(ROOT, 'scripts', 'extract.py');
    if (fs.existsSync(py)) {
      const r = await run('python', [py, file]);
      if (r.ok) {
        try {
          const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
          return parsed;
        } catch {}
      }
      return { kind: OFFICE_EXT.has(ext) ? 'office' : 'image', text: '', error: r.error || r.stderr.slice(0, 200) };
    }
    return { kind: 'office', text: '', error: 'extract.py missing' };
  }
  return { kind: 'binary', text: '' };
}

export async function saveUpload({ name, buffer }) {
  if (!buffer || !buffer.length) throw new Error('empty file');
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than 25 MB`);
  ensureDir(UPLOAD_DIR);
  const clean = safeName(name);
  const id = uid('u_');
  const stamped = `${id}__${clean}`;
  const file = path.join(UPLOAD_DIR, stamped);
  fs.writeFileSync(file, buffer);
  const ext = path.extname(clean).toLowerCase();
  const extracted = await extractText(file, ext);
  return {
    id,
    name: clean,
    path: file,
    bytes: buffer.length,
    ext,
    kind: IMAGE_EXT.has(ext) ? 'image' : OFFICE_EXT.has(ext) ? 'office' : TEXT_EXT.has(ext) ? 'text' : 'binary',
    text: truncate(extracted.text || '', 20000),
    note: extracted.error || (extracted.kind === 'office' ? 'office document' : null),
    uploadedAt: new Date().toISOString(),
  };
}

/** Turn attachments into a compact prompt block. */
export function attachmentBlock(list = []) {
  if (!list.length) return '';
  const parts = [`The user attached ${list.length} file(s). They exist on disk at the paths below — use your tools to read, convert or process them.`];
  for (const a of list.slice(0, MAX_FILES_PER_MESSAGE)) {
    parts.push(`\n### ${a.name} (${(a.bytes / 1024).toFixed(0)} KB${a.kind ? ', ' + a.kind : ''})\npath: ${a.path}`);
    if (a.text) parts.push('content:\n' + truncate(a.text, 6000));
    else if (a.note) parts.push(`(${a.note})`);
  }
  return parts.join('\n');
}

export function listUploads(limit = 50) {
  ensureDir(UPLOAD_DIR);
  return fs
    .readdirSync(UPLOAD_DIR)
    .map((f) => {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
