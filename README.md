# Nexus 7 — Local Agent OS (brain + brake + modern upgrades)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Community contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development
setup, tests, and pull request guidance. Do not commit local runtime data, credentials, or API keys.

**6.9 upgrades (this release):**
- **Browser perception** upgraded toward Browser-Use style: richer interactive indexing, ARIA roles, bbox, page fingerprint for loop detection
- **Recipes** — portable JSON workflows (goose-inspired) with `recipe` tool
- **Agent loop** — action-loop detector + systemOverlay for recipes + better cost metering hooks
- **synthesize_tool** — zero-code CLI/PowerShell/Python tool synthesizer with `{{param}}` templates
- **create_app** — self-synthesizing ephemeral HTML micro-apps (interactive panels)
- **dry_run** — predictive Time-Travel preview for file writes / shell (reversibility score)
- **morning_briefing** — cognitive sleep / morning briefing generator
- **Plugin SDK** (`docs/PLUGIN-SDK.md`) + loader under `data/plugins/`
- **Colored diff-preview** on write/delete/shell approvals
- **DOMSnapshot paint-order** + AX deep browser snapshot
- **Plugins app** + example under `docs/examples/hello-plugin`
- **Sandbox guide** (`docs/SANDBOX.md`) for OS isolation
- **Built-in browser** (no Chrome install required; optional CDP for full control)
- The web app has no runtime npm dependencies; the optional Electron desktop build uses development dependencies.



An agent that runs on your PC, not someone else's cloud. It searches the live web, drives a real
Chrome you are already logged into, runs PowerShell and Python, reads and writes files, pulls Gmail
and Calendar, pushes Kaggle kernels, keeps a local knowledge base about your work, syncs what your
other agents did, and runs any of it on a timer.

The browser-based app needs Node.js 20+ and has no runtime npm dependencies. An optional Electron
desktop shell adds build-time dependencies. HTTP, SSE, Chrome DevTools WebSocket, and multipart
uploads in the base app use Node built-ins.

Nexus's differentiator is the **Reality Loop**: durable, resumable agent missions that carry their
tool history and verification evidence across research, coding, browser work, and connected services.
Missions recover after a restart; uncertain in-flight actions are marked for review instead of blindly
replayed. Explicit user ratings and notes can guide later prompts. This improves workflow fit, but does
not retrain model weights or guarantee superhuman ability. New integrations use existing tool/MCP
boundaries and remain permission-scoped.

```
Double-click  start.cmd
then open     http://127.0.0.1:8787
```

## Desktop app, models, and VS Code

- The optional Electron shell is launched in development with `npm install` then `npm run desktop`.
  Build a Windows installer with `npm run dist:win`. Packaged Nexus data is stored in the user's
  application-data directory; it is not bundled with the executable.
- Ollama is the local-first option. The default vision model is `qwen3-vl:4b`; install it with
  `ollama pull qwen3-vl:4b`. Connections can select an image-capable remote model, but page
  screenshots are then sent to that provider.
- Remote model failover is off by default. Enable it only if you accept that prompts and context may
  be sent to a remote provider. Free API quotas are limited and change; unpaid cloud services may
  retain or review submitted prompts. Never send secrets or private code to a free endpoint.
- Nexus's Browser app launches Chrome with a dedicated persistent profile so cookies and sign-ins can
  survive restarts. Store passwords only in Chrome/Edge Password Manager; Nexus does not store them.
  The lightweight built-in browser is a separate fetch-only fallback with temporary cookies and no
  full login or JavaScript support.
- MCP servers are managed in **MCP Servers**. The official Playwright MCP preset attaches to the
  running Nexus Chrome profile; the official GitHub MCP preset uses Docker and browser-based OAuth.
  MCP servers execute local code, and their tool calls remain subject to Nexus approvals. Review
  each server and its permissions before connecting.
- Nexus can connect to VS Code through the included read-only MCP bridge. See
  [docs/MCP-VSCODE.md](./docs/MCP-VSCODE.md). It exposes search, file reading, brain search, jobs, and
  previews; it does not expose shell execution or file writes.

### Global research workspace

Global Intelligence separates worldwide competitions (including Kaggle, Devpost, Amazon Science,
NASA Space Apps, DrivenData, Zindi, and geospatial/environmental-science challenges) from grants,
funded PhD and research-assistant roles, assistant-professor positions, business intelligence,
geospatial analysis, news/policy, and earning/learning research. Market research and backtests are
paper-only; Nexus does not place live trades. Results are leads to verify on official sources, not
guarantees of income, employment, funding, or competition wins.

### VS Code agents and Google Workspace

- **Plugins & Extensions** contains shortcuts to the official Marketplace for OpenAI Codex,
  GitHub Copilot, Cline, Continue, Python, Jupyter, and GitHub Pull Requests. “Open in VS Code”
  uses VS Code's extension URI; Marketplace links are the fallback. Nexus does not install these
  silently or collect their sign-in credentials. Authenticate in VS Code with the provider.
- Codex access depends on an eligible ChatGPT plan. GitHub Copilot has a free offering with limits.
  Cline and Continue are free extensions, but hosted model/API usage can cost money; Cline can use
  local Ollama. Python and Jupyter support Kaggle and geospatial notebook workflows.
  [Codex](https://developers.openai.com/codex/ide) ·
  [Copilot](https://code.visualstudio.com/docs/copilot/overview) ·
  [Cline](https://docs.cline.bot/getting-started/installing-cline) ·
  [Continue](https://docs.continue.dev) ·
  [Python](https://code.visualstudio.com/docs/python/python-tutorial) ·
  [Jupyter](https://code.visualstudio.com/docs/datascience/jupyter-notebooks)
- **Skills → Google Workspace quick skills** starts bounded Gmail, Drive/Docs, Sheets, DOCX, and
  PowerPoint tasks. Gmail/Drive/Docs/Sheets rely on the existing Google OAuth integration; Nexus
  never needs your Google password. Gmail and Drive actions are read-only in these starters; email
  replies are drafted in chat, not sent. `office-docs` and `office-decks` create local DOCX/PPTX
  artifacts and verify output; uploading or sharing is not automatic. External `SKILL.md` files
  remain untrusted instructions: inspect scanner warnings and read them before enabling.

Nexus already has its own agent loop, local knowledge retrieval, skills, and MCP support. LangChain
is not required to use these capabilities. Mission checkpoints and evidence are stored locally under
the runtime data directory; do not put that directory in a public fork.

## Daily intelligence and opportunity research

- On first startup, Nexus creates or updates a local-time daily briefing at **08:30**. It researches
  major global news, science/medicine, AI/computing, space, energy/climate, and business/economics,
  cites sources, labels uncertainty, and includes one researched improvement idea. It is a curated
  digest, not exhaustive coverage. The latest report appears on the desktop widget and is saved under
  `data/briefings/`.
- The **Business Analyst** role and **Business Opportunity Review** recipe assess demand, competition,
  distribution, startup costs, conservative unit economics, downside, and a low-cost validation test.
  They cannot guarantee income or make anyone rich.
- The Missions app includes a **Kaggle research workflow** starter for researching official rules,
  permitted public papers/repositories, reproducible baselines, validation, and experiments. No agent
  can guarantee a competition win; free compute, data access, model quotas, and competition rules
  impose real limits. Submission remains subject to your approval.
- Nexus opens in its general-purpose chat first. Kaggle and Business Opportunities are separate
  workspaces with separate chat histories, saved roles, and specialist guidance; switching workspaces
  saves the current thread before opening the other context. Existing workspace settings are retained
  while the Business workspace is added on upgrade.

## The 19 apps

| App | What it does |
|---|---|
| **Nexus** | The agent. Streaming loop, visible tool calls, skills, memory, brain context. |
| **Search** | Live web search (DuckDuckGo by default, no key) + page reader. |
| **Browser** | Chrome over CDP with a dedicated persistent profile — your logins survive restarts. **Tab strip inside the panel**: open, switch, close tabs, live view toggle, click/type by element number. |
| **Clusters** | Specialist role sub-agents in parallel, then one synthesised answer. |
| **Missions** | Persistent, resumable tasks with tool history, checkpoints, action approvals, verification evidence, and user-rated learning notes. |
| **Automations** | `every 30m`, `daily 09:00`, `*/15 * * * *`, or an ISO date. Headless runs still hit the approval gate. |
| **Gmail** | Real Gmail/Calendar/Drive/Sheets/Docs over your own OAuth client. |
| **Kaggle** | Kernels list/status/log/output/push, competitions, datasets. |
| **Terminal** | Guarded PowerShell with captured output. |
| **Lab** | Background job runner: python/GEE/Kaggle/deck runs keep going past the request, keep a full log, incremental tail, kill the whole process tree. Plus recent artifacts with preview. |
| **Skills** | `SKILL.md` folders, enable/disable, budgeted prompt injection. |
| **Memory** | Short durable notes. |
| **Brain** | The long-term knowledge base: facts, projects, decisions, deadlines, lessons, plus a profile of you. Imports what Codex and Claude Code did on this machine. |
| **Vault** | AES-256-GCM credential store. scrypt-derived key, passphrase never stored, key in RAM only. |
| **Community** | Discord bot with two trust levels + a copy-paste server blueprint. |
| **Safety** | Permission modes, rule engine, audit log, file checkpoints. |
| **Files** | Browse the workspace, read any file. |
| **Doctor** | Pass/fail on every integration with the exact fix. |
| **Connections** | One place to set up and test local/cloud models, search, Google, Kaggle, GitHub, Discord, and Telegram. |
| **Settings** | System preferences, browser port, and persona. |

## Three things need you on first run

**1. A model.** Either local Ollama, or any OpenAI-compatible API.
- Local: install Ollama, then `ollama pull qwen2.5:7b` (or `qwen2.5-coder:7b`).
- Cloud API: open **Connections**, choose **Cloud API**, and enter the endpoint, model, and key.
  Use **More options** for provider presets, saved profiles, and free-model discovery. Test the
  connection before selecting the model. The Windows desktop app encrypts provider keys with
  Windows secure storage; browser/server development mode holds new keys in memory only. Provider
  keys do not require the Nexus Vault. Never paste API keys into chat.
- Presets include OpenRouter (with live free-model discovery), Vercel AI Gateway, NVIDIA NIM,
  Ollama Cloud (local Ollama sign-in or its direct API), Gemini, Groq, DeepSeek, Together, Cerebras,
  and LM Studio. Hosted/free quotas and model availability vary by provider and account.
- Automatic provider fallback is off by default: Nexus tries only the selected provider. You can
  separately enable local Ollama fallback or remote failover in Connections → More options. Remote
  failover may send prompts and context to other providers. The Vercel AI Gateway works through its
  OpenAI-compatible endpoint; the Vercel AI SDK is not required for this integration. Cline SDK is
  an agent runtime, not a generic model endpoint, so it belongs in a separate runner integration.
- Local inference still requires a running Ollama service and an installed model; Doctor reports
  whether the service is reachable. Enabling local fallback does not install Ollama or its models.

**2. Optional integrations.** The Vault is only needed for credentials or backups you choose to
store there. Model API keys in the Windows desktop app use Windows secure storage instead.

**3. Tokens, if you want the integrations.** Google OAuth client (Cloud Console → Credentials →
redirect URI `http://127.0.0.1:8787/oauth/callback`), Kaggle API key, Discord bot token. Doctor and
each app tells you exactly what is missing.

## How safety actually works

Every tool call passes through `policy.gate()` in `lib/policy.js` — one choke point, no bypass.

| Mode | Behaviour |
|---|---|
| **Plan** | Research only. Writes and commands are hard-denied. |
| **Ask** *(default)* | Reads run freely; writes, commands and browser actions ask first. |
| **Auto** | File writes inside the workspace run freely; commands and deletes still ask. |
| **Full** | No prompts — but destructive commands and system paths stay blocked. |

- **Rules** (`tool:pattern` → allow/deny) beat the mode, and **deny always beats allow**.
- **Approvals** arrive as a card in chat *and* a global panel, so scheduled/headless runs are covered.
  Timeout = deny.
- **Checkpoints** snapshot a file before the agent edits it; restore from the Safety app.
- **Audit** logs every allow, deny and execution to `data/audit.jsonl`.
- **Budgets**: step count, tool calls and wall-clock per run.
- **MCP tools** are classified as `exec` — approval by default.

Verified by `scripts/test-policy.mjs` (25 assertions), `scripts/test-approval.mjs` (live SSE
round-trip), `scripts/test-vault.mjs` (25 assertions incl. "a backup never contains a plaintext
password") and `scripts/test-brain.mjs` (16 assertions). The design rationale is in
`docs/ARCHITECTURE.md`.

## The brain

`data/brain.jsonl` — one line per memory, human-readable, deletable.

- **Retrieval**: BM25-lite over title/body/tags with IDF, plus recency and usage boosts. Boosts only
  refine an existing lexical match, so an unrelated memory can never float up.
- **Profile**: preferences, active projects, open tasks, tracked competition deadlines, recent
  decisions — injected into the prompt every run.
- **Auto-grow**: every finished conversation is recorded as a session memory.
- **Sync**: reads new session logs and instruction files from `~/.codex`, `~/.claude` and this
  workspace (read-only, bounded, summaries only). Files that look like they contain a secret are
  skipped, never imported.
- **Deliberately not a vector DB**: at hundreds-to-thousands of entries on one machine, a token index
  is faster, dependency-free, and inspectable. The schema is versioned so a sqlite/embeddings backend
  can be added behind the same `search()` without touching callers.

## Encrypted vault + Drive backup

`lib/vault.js`: scrypt(N=32768) → AES-256-GCM per entry → `data/vault.json` is ciphertext.
`lib/backup.js` seals a bundle (settings with every secret redacted, skills, roles, tasks, memory,
vault ciphertext) with the same key and uploads it to a **hidden Drive app-data folder**. The backup
file is encrypted before it leaves the process — Drive never sees a password.

## Discord

`lib/discord.js` — gateway bot, no dependencies.

- Your DM or the channels listed as **admin** → full agent, normal permission mode.
- Every other channel → `plan` policy: it can search and answer, and a write or command is
  **hard-denied by the policy layer**, not merely discouraged by the prompt.
- Commands: `!ping`, `!pending`, `!approve`, `!deny`.
- Server blueprint (channels, roles, rules, onboarding copy) is built into the Community app.

I will not build auto-join/auto-post bots for third-party communities — that is spam tooling. The
agent helps you find communities and draft an intro; you press send.

## Layout

```
public/            desktop shell: windows, dock, palette (plain ESM, no framework)
server.js          HTTP API + SSE streams + OAuth callback
lib/config.js      settings store, binary discovery, paths
lib/llm.js         Ollama + OpenAI-compatible streaming
lib/agentloop.js   ReAct loop, roles, cluster synthesis, budgets, compaction
lib/tools.js       tool registry (18 native + dynamic MCP) — the single execution choke point
lib/jobs.js        background job runner: ring buffer, incremental reads, taskkill tree kill
lib/intel.js       opportunity scoring, money plan, platform compliance rules
lib/policy.js      permission modes, rules, approval broker, audit, checkpoints
lib/brain.js       knowledge store, retrieval, profile, agent-log sync
lib/vault.js       scrypt + AES-256-GCM credential store
lib/backup.js      sealed backup bundle -> local + Drive app-data folder
lib/discord.js     gateway bot, admin/member trust levels
lib/mcp.js         MCP stdio client (any MCP server works)
lib/browser.js     CDP client over Node's global WebSocket
lib/google.js      OAuth2 + Gmail/Calendar/Drive/Sheets/Docs
lib/kaggle.js      Kaggle API v1 incl. multipart kernel push
lib/scheduler.js   interval/daily/cron-lite scheduler
lib/skills.js      SKILL.md discovery, enable/disable, budgeted injection
data/              settings, brain.jsonl, vault.json, audit.jsonl, tasks.json, workspace/
skills/            drop a folder with SKILL.md here
scripts/           contract tests + mock LLM + CDP probes
docs/              ARCHITECTURE.md
```

## Honest limits

- **Kaggle**: this automates the pipeline — radar, plan, baseline, iterate, push, poll, log. It does
  not guarantee a medal. No tool can.
- **Sandboxing** is process-level (fixed cwd, scrubbed env, timeout, destructive blocklist, path
  jail), not OS-level like Seatbelt/Landlock. That is the next hardening step.
- **No session resume across restarts** yet; the transcript lives in the browser tab.
- **Discord** needs the MESSAGE CONTENT intent enabled in the Developer Portal.
- **Browser automation** is element-indexed, not visually grounded — no screenshot-reasoning model.
