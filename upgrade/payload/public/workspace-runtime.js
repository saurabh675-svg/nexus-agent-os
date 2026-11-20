// Shared UI transport and polling; no changes to the agent engine or API contracts.
export function createEventDecoder(on) {
  let buffer = '';
  function parse(record) {
    let event = 'message'; const data = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const key = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (key === 'event') event = value;
      if (key === 'data') data.push(value);
    }
    if (!data.length) return;
    let payload;
    try { payload = JSON.parse(data.join('\n')); }
    catch { throw new Error('Nexus received an unreadable response. Retry the task.'); }
    on(event, payload);
  }
  return {
    push(text) {
      buffer += text;
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Nexus response exceeded the display limit.');
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const record = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        parse(record);
      }
    },
    finish() { if (buffer.trim()) parse(buffer); buffer = ''; },
  };
}

export async function streamPost(path, payload, on, signal, request = fetch) {
  let reader;
  try {
    const res = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (!res.ok) {
      let detail = '';
      try { const error = await res.json(); detail = error.error || error.message || ''; } catch {}
      throw new Error(detail || `Nexus request failed (HTTP ${res.status}).`);
    }
    if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Nexus did not return a task stream. Check the server and model settings.');
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = createEventDecoder(on);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(decoder.decode(value, { stream: true }));
    }
    events.push(decoder.decode()); events.finish();
  } catch (e) {
    on('error', { message: e?.name === 'AbortError' ? 'Stopped.' : 'Connection or response error: ' + (e.message || e) });
  } finally {
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}

export function panelPoll(body, callback, milliseconds) {
  let running = false;
  const timer = setInterval(async () => {
    if (!body.isConnected) return clearInterval(timer);
    const panel = body.closest('.win');
    if (document.hidden || panel?.style.display === 'none' || panel?.dataset.inactive === 'true' || running) return;
    running = true;
    try { await callback(); } catch { /* Retry on the next visible tick. */ }
    finally { running = false; }
  }, milliseconds);
  body.addEventListener('nexus-dispose', () => clearInterval(timer), { once: true });
  return timer;
}
