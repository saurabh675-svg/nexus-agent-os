# OS-level sandbox notes (Nexus 6.9)

Nexus is a **local agent OS**. It is powerful on purpose. Safety is layered; no single layer is absolute.

## What Nexus already enforces

| Layer | Behavior |
|-------|----------|
| **Policy modes** | Plan / Ask / Auto / Full — writes, shell, browser gated |
| **Approval gate** | Diff-preview before file writes; command preview for shell |
| **Checkpoints** | Pre-write file copies under `data/checkpoints/` |
| **Destructive blocklist** | format, diskpart, rm -rf /, shutdown, etc. hard-denied |
| **Path jail** | Workspace-first; system paths refused |
| **Vault** | AES-256-GCM credentials; passphrase never stored |
| **Env scrub** | Shell does not inherit arbitrary secrets by design |
| **Budgets** | Step, tool-call, wall-clock limits |
| **Action-loop detector** | Repeated identical tool calls stop the run |

## Recommended OS isolation

Run Nexus inside one of these when experimenting with **Full** mode or untrusted skills/plugins:

### Windows
- **Windows Sandbox** (optional feature): disposable desktop; close window = wipe.
- **Hyper-V / VMware** VM with a snapshot before agent work.
- **Job Objects** (future): Nexus can eventually wrap shell in a Job Object to kill process trees — not fully wired yet.

### macOS
- Run under a non-admin user dedicated to agent work.
- **Seatbelt / sandbox-exec** profiles for the Node process (advanced).
- Prefer VM (UTM / Parallels) for untrusted web automation.

### Linux
- **bubblewrap** (`bwrap`) or **Firejail** around `node server.js`.
- **systemd-nspawn** or a container with the workspace mounted read-write and home mostly read-only.
- Example sketch (adjust paths):

```bash
bwrap --ro-bind / / --bind "$PWD/data/workspace" /home/workdir/artifacts/workspace \
  --dev /dev --proc /proc --unshare-pid \
  node server.js
```

## Browser profile

Chrome is launched with a **dedicated profile** under `data/chrome-profile`. That keeps your daily browser separate, but the agent still controls a real browser with real logins stored in that profile. Treat that profile as sensitive.

The Nexus Browser app uses this profile for persistent cookies and sign-ins. Store passwords only
with Chrome/Edge Password Manager; password input values are omitted from normal browser snapshots.
The fetch-only built-in fallback has an in-memory cookie jar and is not suitable for full sign-ins.

## Plugins & MCP

- Plugins are pure ESM; they still go through `policy.gate` for tools.
- MCP servers are **exec-class** — only add servers you trust.
- Review `docs/PLUGIN-SDK.md` before installing third-party plugins.

## Threat model reminders

1. A prompt-injected page can try to trick the model; tool output is treated as data, not instructions, but the model can still *choose* bad tools — the gate is the brake.
2. Unattended scheduled runs still hit the approval broker when mode is Ask; if no human answers, the call times out and is denied.
3. “Full” mode is for machines you can wipe.

## Roadmap (not in 6.9)

- Job Object / seatbelt wrappers for shell by default
- Optional network allowlist for `open_page` / browser
- Signed plugin manifests
