# Nexus 7.0.0 — Agent OS

Major desktop-shell release. Same zero-deps core; modern OS UI and stronger built-in browsing.

## Desktop shell (Windows 11 × Ubuntu)

- **Acrylic / Mica-style** panels: blurred taskbar, launcher, windows
- **Centered taskbar** with hover lift, active indicator glow
- **Ubuntu-style top panel** (model / browser / google pills + clock)
- **Win11-style Start launcher** (search + app grid)
- **System tray** (bottom-right): Action Center, Workspaces, Plugins, Settings
- New `public/os7.css` theme layer on top of existing styles
- Wallpaper grid + soft bloom gradients

## Browser

- **Built-in engine** (no Chrome required): tabs, snapshot indices, click, type, form submit
- **Cookie jar** for session continuity on classic form logins
- **CDP** still available for Chrome / Edge / Brave when installed (`browser.engine`: auto | builtin | cdp)

## Carried forward

Recipes, Spatial Workspaces, Semantic Event Bus + Action Center, cognitive sleep cycles,
Plugins SDK + UI, diff-preview approvals, synthesize_tool, create_app, dry_run, morning_briefing,
deep AX + DOMSnapshot when CDP is live.

## Requirements

- Node.js 20+
- Zero npm install
- Optional: Chrome/Edge for full browser automation
