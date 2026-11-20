# Nexus 6.8.0

Built on 6.7 Phase 1–3.

## Highlights

### Paint-order DOMSnapshot + AX (browser)
- Parallel CDP: `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot` (`includePaintOrder`, computed styles)
- Interactive indices still drive clicks; AX enriches labels; paint stats returned

### Diff-preview UX
- File write/append: LCS diff in approval card (`+` / `-`)
- File delete: preview of lines that would be removed
- Shell / synthesize_tool: command preview in the approval card
- CSS: `.diff-box` scrollable panel

### Plugin SDK
- `docs/PLUGIN-SDK.md` — contract for pure ESM plugins
- `lib/plugins.js` — scans `data/plugins/<id>/`, `activate(api)`, registerTool / emit / on
- Boot loads plugins; `GET/POST /api/plugins` (list / reload)

## Still true
Zero npm deps. Policy gate, vault, checkpoints, live Event Bus, cognitive sleep, Spatial Workspaces, Recipes.
