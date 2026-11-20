# Nexus Plugin SDK (6.8)

Nexus stays **zero npm dependencies**. Plugins are plain ESM modules under `data/plugins/` that export a small contract. They can register tools, MCP servers, and event-bus listeners — nothing runs outside the policy gate.

## Layout

```
data/plugins/
  my-plugin/
    plugin.json          # manifest
    index.js             # ESM entry (Node 20+)
```

### plugin.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does a useful thing",
  "main": "index.js",
  "permissions": ["tools", "events"]
}
```

Permissions are advisory labels shown in Doctor/Safety. Real enforcement is still `policy.gate()`.

### index.js contract

```js
/**
 * @param {object} api
 * @param {(name: string, def: {desc, params, run}) => void} api.registerTool
 * @param {(type: string, payload?: object, opts?: object) => void} api.emit
 * @param {(fn: (ev) => void) => () => void} api.on
 * @param {object} api.config   // read-only public settings
 * @param {string} api.workspace
 */
export async function activate(api) {
  api.registerTool('hello_world', {
    desc: 'Example plugin tool',
    params: { name: 'string?' },
    async run({ name }) {
      return { ok: true, message: `hello ${name || 'world'} from plugin` };
    },
  });

  const off = api.on((ev) => {
    if (ev.type === 'terminal.error') {
      // react to bus events
    }
  });

  return () => {
    // optional deactivate
    off?.();
  };
}
```

## Loading

On server start, Nexus scans `data/plugins/<id>/plugin.json`, dynamically imports `main`, and calls `activate`. Failures are logged; one bad plugin cannot crash the OS.

Enable/disable via Settings → Plugins (or `settings.plugins.enabledIds`).

## Rules for plugin authors

1. **No native addons** — pure JS only (keeps the zero-deps story).
2. **Every side effect goes through tools** so `policy.gate` still applies.
3. **Do not read secrets** from disk; use Vault via existing tools if needed.
4. Prefer emitting semantic events (`api.emit`) over polling.
5. Keep tool results under ~8 KB of text; large artifacts belong in the workspace.

## MCP as plugins

Prefer connecting an MCP server from **MCP Servers** when the capability already exists as a community MCP. Use a local plugin only when you need Nexus-specific event bus or approval UX.

## Example: webhook notifier

```js
export async function activate(api) {
  api.on((ev) => {
    if (ev.severity !== 'error') return;
    // fire-and-forget; never block the bus
    fetch('https://example.invalid/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: ev.type, payload: ev.payload }),
    }).catch(() => {});
  });
}
```

## Versioning

- **6.8** introduces the loader + this contract.
- Breaking changes to `api` will bump the major plugin API version in `plugin.json` (`apiVersion: 1`).
