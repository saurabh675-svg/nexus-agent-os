# Nexus 6.7.0 — Upgrade notes

Built on top of 6.6.0 with research-backed modern patterns (Browser Use, goose recipes, Playwright-style accessibility awareness, predictive dry-run) plus the roadmap items from the internal upgrade plan.

## What changed

### Browser (`lib/browser.js`)
- Snapshot now uses a broader interactive selector set + ARIA roles
- Filters by visibility, opacity, pointer-events, near-viewport
- Returns `role`, `bbox`, `checked`, `disabled`, `value`, `fingerprint`
- Fingerprint feeds the new action-loop detector

### Agent loop (`lib/agentloop.js`)
- Action-loop detector: identical tool+args ≥ 3 times → stop with clear message
- `systemOverlay` argument for recipe / session instructions
- Better token/cost estimation hooks during tool steps

### New tools (`lib/tools.js`)
| Tool | Purpose |
|------|---------|
| `recipe` | list / get / save / delete / run portable JSON workflows |
| `synthesize_tool` | wrap CLI/PowerShell/Python templates with `{{param}}` |
| `create_app` | generate interactive HTML micro-apps (ephemeral GUI) |
| `morning_briefing` | cognitive morning briefing from memory + brain + scheduler |
| `dry_run` | Time-Travel preview of file write/append/delete or shell risk |

### New module
- `lib/recipes.js` — goose-inspired recipe store under `data/recipes/`

## Still true
- Zero npm dependencies
- Approval / policy / vault / checkpoints unchanged and still first-class
- Node 20+ only

## Not yet fully wired (roadmap Phase 2/3)
- Desktop wallpaper Morning Briefing widget UI
- Full Semantic Event Bus → Action Center cards
- Spatial goal-bound workspaces
- Full multi-tree CDP AX+Snapshot merge (current snapshot is evaluate-based for latency/zero-deps)

## How to use new tools (examples)

```
recipe action=list
recipe action=run id=morning-brief
synthesize_tool action=create id=ping name=Ping command="ping -n 1 {{host}}" params={"host":"1.1.1.1"}
dry_run tool=files path=notes.md fileAction=write content="hello"
create_app action=create title="Port scanner" html="<button id=b>Scan</button>" js="..."
morning_briefing
```

## Phase 2 (continued)

### Semantic Event Bus (`lib/eventbus.js`)
- Ring-buffer + JSONL persistence of terminal/browser/job/scheduler events
- `intentCards()` turns failures into proactive Action Center cards
  (e.g. `ModuleNotFoundError: pandas` → Install / Diagnose actions)
- Shell failures automatically emit via `runShell`

### Action Center (UI + `/api/action-center`)
- New app **Action Center** (⚡) with intent cards
- Menubar badge shows open card count
- One-click “Act” opens Nexus chat with a ready prompt

### Spatial Workspaces (`lib/workspaces.js` + `/api/workspaces`)
- Default / Research / Kaggle / Dev workspaces
- Switching injects goal + systemOverlay into the agent prompt
- Menubar pill shows active workspace; **Workspaces** app to switch/manage

### Morning Briefing wallpaper widget
- `#briefing-widget` on the desktop wallpaper
- Loads `/api/briefing` (latest.md written by `morning_briefing` tool)
- Refresh / Open full buttons

### Recipes UI
- **Recipes** app lists portable workflows and runs them via chat

### APIs added
- `GET/POST /api/action-center`
- `GET/POST /api/workspaces`
- `GET/POST /api/recipes`
- `GET /api/briefing`
- `GET /micro-app/:id`

## Phase 3

### Deeper AX browser snapshot (`lib/browser.js`)
- `snapshot({ deep: true })` (default): in-page interactive indices **plus** CDP `Accessibility.getFullAXTree`
- Weak labels enriched with AX name/role
- Returns `ax`, `axHintCount`, `axSample` for debugging
- Falls back to evaluate-only if AX fails

### Live Semantic Event Bus → SSE
- `eventbus.on` → `broadcast('bus' | 'intent' | 'briefing')` to all EventSource clients
- Action Center badge and toasts update without polling when terminal fails or briefing is ready

### Cognitive Sleep Cycles (`lib/sleepcycle.js`)
- `runSleepCycle()` consolidates via `morning_briefing` tool and trims event log
- On server boot: ensures **daily 08:30** automation "Cognitive morning briefing"
- Night idle watcher (02:00–07:00, ~45m quiet) can trigger a nap
- Manual: `POST /api/sleep-cycle` with `{ "force": true }`

