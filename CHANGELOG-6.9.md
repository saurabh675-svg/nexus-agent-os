# Nexus 6.9.0 — Release polish

## Plugins UI
- New **Plugins** app (⌘) in the launcher/dock
- Lists discovered plugins with loaded / error status
- One-click **Reload plugins** (`POST /api/plugins` action=reload)

## Documentation
- `docs/PLUGIN-SDK.md` — contract for pure ESM plugins
- `docs/SANDBOX.md` — OS isolation notes (Windows Sandbox, bwrap, threat model)
- `docs/examples/hello-plugin/` — copy into `data/plugins/hello/` to try

## Config
- `settings.plugins.enabledIds` — empty array means load all discovered plugins

## Carried from 6.8
Paint-order DOMSnapshot + AX, colored diff-preview, live Event Bus, cognitive sleep, Spatial Workspaces, Recipes, synthesize_tool, create_app, dry_run.

## Public packaging
- Version **6.9.0** in package.json
- Zero npm dependencies; Node 20+
- Zip excludes runtime `data/` so user state is not overwritten


## 6.9.1 — Built-in browser (no Chrome required)

- New `lib/webbrowser.js`: fetch-based engine with tabs, snapshot indices, click (follow links), type (form fields), form submit
- `browser` tool uses **builtin** when Chrome/Edge is missing or `settings.browser.engine = 'builtin'`
- `engine: 'auto' | 'builtin' | 'cdp'` in settings (default auto)
- Expanded binary detection: Chrome, Edge, Brave, Chromium (Linux/Mac/Windows)
- CDP remains available for JS-heavy sites, mouse, vision, screenshots
