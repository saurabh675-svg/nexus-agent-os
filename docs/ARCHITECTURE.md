# Reverse-engineering the agent frameworks — and rebuilding them with real safety

**Scope and method.** This is an architectural teardown based on public sources and observable
behaviour, not binary decompilation: published documentation, open-source repositories, the wire
protocols the tools speak, and the behaviour of the host app this was built inside. Anything I could
not verify is labelled. Nothing here circumvents licensing, authentication or DRM, and nothing copies
proprietary source.

Provenance tags: `[oss]` open-source repository · `[docs]` vendor documentation · `[observed]` seen
directly in this environment · `[inferred]` reasoned from protocol/behaviour.

---

## 1. They all converged on the same seven subsystems

Independent products, same skeleton. That convergence is the actual finding — it tells you what an
agent *is*, once you strip the branding.

| # | Subsystem | What it really does | Why it exists |
|---|---|---|---|
| 1 | **Turn loop** | model → parse tool call → execute → feed result back → repeat until no tool call, with a step ceiling | an LLM alone cannot act; the loop is the actuator |
| 2 | **Tool registry** | name, description, JSON schema, executor; prompt is generated from the registry | the model can only call what is described to it |
| 3 | **Permission gate** | classify each call (read / write / exec / destructive) → allow, deny, or ask | the single highest-risk surface in the product |
| 4 | **Context manager** | system prompt + project instructions file + memory + truncation/compaction of tool output | context is finite; naive agents starve themselves |
| 5 | **Session store** | transcript, resume, per-project scope | long tasks outlive one process |
| 6 | **Extension layer** | skills/prompts, hooks, MCP servers | nobody can ship every integration |
| 7 | **Delegation** | sub-agents with narrowed tools, parallel fan-out, synthesis | context isolation + wall-clock speed |

Everything else — the TUI, the diff viewer, the marketplace — is packaging around those seven.

## 2. Where each one actually differs

**Codex CLI** `[oss][docs]`
Rust, terminal-first, patch-oriented edits. Its distinguishing choice is that the *sandbox* is the
primary control, not the prompt: a workspace-write sandbox that blocks network and writes outside the
repo, with approval policy as a second layer. Also: `AGENTS.md` as project instructions, and an
exec mode designed for CI where no human can answer a prompt.

**Claude Code** `[docs][inferred]`
The most explicit permission model of the group: named modes (default / accept-edits / plan /
bypass-permissions), per-tool allow/deny rules in settings, pre/post tool **hooks** that can veto a
call, `CLAUDE.md` project memory, sub-agents, and skills. Its safety posture is "deny by default at
the tool boundary, and make the boundary configurable" — which is why it is the one people actually
trust with a real repository.

**Z.ai / GLM agents (AutoGLM, GLM-PC line)** `[oss][docs]`
Different axis entirely: a *GUI action space* (screenshot → tap/type/scroll) rather than a shell tool
space. Planning plus a screen-grounding model. Consequence: far less permission machinery, because
the agent acts through the same UI a human does — but also no filesystem guarantees, and screenshot
content is untrusted input by definition.

**AutoClaw** `[observed]`
Host application around the same loop: saved agents with fixed roles, `SKILL.md` skills, delegation
to sub-agents, workspace artifacts as the delivery channel, IM bridges as a second front-end, and
domain tool routing (code / design / legal). Its pattern is *composition*: many narrow agents with
their own instructions, orchestrated, rather than one giant prompt.

**OpenClaw** `[docs][inferred]`
Local-first personal-assistant daemon shape: long-running gateway, channel adapters (chat networks),
plugin tools, scheduled/heartbeat tasks, per-channel sessions. Its pattern is *residency* — the agent
lives on the machine and stays reachable, instead of being a process you start per task.

**The synthesis:** Codex contributes sandboxing, Claude Code contributes the permission matrix and
hooks, GLM contributes the screen as a tool, AutoClaw contributes skills + role delegation, OpenClaw
contributes residency + scheduling. Nexus takes one of each.

## 3. What is implemented here

| Pattern | Source inspiration | Implementation | Safety delta vs. the original |
|---|---|---|---|
| ReAct loop + tool protocol | all | `lib/agentloop.js` | step, tool-call and wall-clock budgets enforced *before* the next model turn |
| Tool registry | all | `lib/tools.js` (14 native + dynamic MCP) | every call funnels through one `runTool()` choke point |
| Permission modes | Claude Code | `lib/policy.js` — `plan / ask / auto / full` | `ask` is the default; `plan` cannot write at all |
| Rule engine | Claude Code allow/deny | `policy.decide()` glob rules | **deny always beats allow**, regardless of insertion order (tested) |
| Approval round-trip | Codex/Claude prompts | `policy.gate()` → SSE → UI → `POST /api/approvals` | works for headless/scheduled runs too; 180 s timeout **denies** by default |
| Sandboxed exec | Codex sandbox | `runShell()` — fixed cwd, scrubbed env, timeout, destructive blocklist | no cwd escape, no inherited secrets, kill-tree on timeout |
| Path jail | Codex workspace-write | `assertWritable()` in `lib/tools.js` | blocks `C:\Windows`, `Program Files`, `/etc`; confines to project + home |
| Checkpoints / rollback | Claude Code edits | `policy.checkpoint()` before every file mutation | restores the prior file byte-for-byte |
| Audit log | hooks | `data/audit.jsonl` + Safety app | every allow/deny/exec with args, latency, result |
| Context compaction | all | `trimHistory()` — last 8 messages verbatim | **bug found and fixed:** old scheme elided *recent* tool output and silently starved the model |
| MCP | all four | `lib/mcp.js` — stdio JSON-RPC 2.0 client | MCP tools classify as `exec` → approval by default |
| Skills | AutoClaw | `lib/skills.js` + `SKILL.md` front matter | enable/disable per skill; budgeted injection |
| Sub-agent fan-out | AutoClaw | `runCluster()` — 7 roles, parallel, then synthesis | child runs inherit the parent policy gate |
| Residency + schedule | OpenClaw | `lib/scheduler.js` — interval/daily/cron-lite | headless runs still hit the approval broker |
| Browser as a tool | GLM-PC | `lib/browser.js` over CDP | dedicated profile; element-indexed actions; screenshots, not blind clicks |

## 4. Deliberate omissions

- **No `bypassPermissions` default.** Full-auto exists but is opt-in and still refuses destructive
  commands and system paths.
- **No credential ingestion.** Google access is OAuth with a token you own; browser sessions live in
  a separate profile directory. Nothing harvests cookies or passwords.
- **No unsandboxed shell as the only path.** Shell is one tool among many, gated, jailed, timed.
- **No hidden tool execution.** Every call is an expandable chip in the transcript plus an audit row.
- **No auto-join / auto-post across third-party communities.** That is spam tooling; the app helps
  you research communities and draft an intro, then you send it.

## 5. Threat model

| Threat | Control |
|---|---|
| Model is prompt-injected by a web page | tool output is data, never instructions; writes/exec still require approval; page text is truncated and labelled |
| Model loops and burns tokens/GPU | step + tool-call + wall-clock budgets, each with an explicit stop message |
| Model deletes or corrupts work | destructive class is hard-denied; every mutation is checkpointed first |
| Model exfiltrates secrets | env scrubbed in shell; path jail; no credential store exposed to tools |
| Approval fatigue → user clicks allow blindly | approval shows tool, risk class, and the exact argument summary; "always allow" writes a visible, revocable rule |
| Unattended scheduled run does something risky | approval broker still applies; no human → timeout → deny |
| Rogue MCP server | server must be added explicitly; its tools are `exec`-class; name and command shown in UI |

## 6. Verification

- `scripts/test-policy.mjs` — 25 assertions: mode matrix, rule precedence, destructive block,
  approval allow/deny, audit, checkpoint restore. **25/25 pass.**
- `scripts/test-approval.mjs` — live SSE round-trip against a mock OpenAI-compatible endpoint:
  gate asks → HTTP approval → `echo` executes → loop continues → final answer. **pass.**
- `scripts/probe-press.mjs` — proved trusted CDP keystrokes are ignored by some React sites;
  `press()` now falls back to a synthetic DOM event *only* when nothing changed.

## 7. If you want to go further

Session persistence + resume, token/cost accounting per run, a real OS sandbox (Job Objects on
Windows, seatbelt on macOS), diff-preview before writes, and a plugin SDK on top of the MCP client.
