---
name: work-kaggle-supervision
description: How this user runs Kaggle: supervise runs, never auto-submit, track quota and deadlines.
source: derived from 4 automation(s) on this PC
---

# Kaggle supervision — observed practice

Derived from the automation inventory on this machine, not from generic advice.

## The standing rules that were found in the user's own prompts
- **Do not auto-join, accept terms, upload versions or submit.** Prepare the exact action and wait for a human decision.
- Preserve the champion score in the brain so a weaker candidate never replaces it.
- Track quota and the daily submission allowance before proposing anything.
- Stay quiet when nothing changed. Notify only on: score change, run finished/failed, deadline risk, or a validated candidate ready to submit.

## How to work
1. `job` tool to poll status and read logs (never `shell` for a long poll).
2. Read the log tail on failure; quote the first traceback, not the last line.
3. Any submission step goes through the permission gate with the exact command shown to the user.

## What "done" means
A status, a number read from the log, and the next action — not "it should work".

## Provenance
- kaggle-daily-opportunity-digest (heartbeat, ACTIVE)
- kaggle-progress-email-digest (heartbeat, ACTIVE)
- kaggle-quantum-circuit-monitor (heartbeat, ACTIVE)
- kaggle-submission-and-deadline-digest (heartbeat, ACTIVE)
