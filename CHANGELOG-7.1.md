# Nexus 7.1.0

## P0 Browser
- Stable **@eN refs** on interactive elements (`ref: "@e3"`) + `data-nx-ref`
- **Viewport-only** snapshot filter (`viewportOnly: true` default) for fewer tokens
- Click accepts `ref` or `index`
- Desktop helper `clickWithVisionFallback` (ref → vision)

## P1 MCP + routing
- Catalog adds **Playwright MCP** + **Fetch** presets
- `settings.routing` { cheapModel, strongModel, enabled }
- `subagents.routeStep(kind)` for cheap vs strong hints

## P2 Subagents
- `subagent` tool: parallel workers with shared goal, summary return

## P3 Desktop CUA (starter)
- `desktop` tool: screenshot | click | type | hotkey
- Windows PowerShell, macOS screencapture/osascript, Linux xdotool
- Classified as **exec** (approval in Ask mode)

## UI
- Same 7.0 Win11×Ubuntu shell
