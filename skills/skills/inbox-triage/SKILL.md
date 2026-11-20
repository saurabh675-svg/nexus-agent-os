---
name: inbox-triage
description: Turn a Gmail inbox into a ranked action list, then draft replies without sending them.
---

# Inbox triage

## Pull
`gmail` `{"action":"search","query":"newer_than:2d -category:promotions -category:social"}` then `{"action":"read","id":"…"}` for anything that looks actionable.

## Classify each thread
- **Do now** — direct request from a person, waiting on you, deadline inside 48h.
- **Schedule** — needs a calendar slot or a longer reply.
- **Read later** — FYI, no action.
- **Ignore** — automated notifications, receipts, marketing.

## Rules
- Judge by sender + the actual ask, not by subject line alone.
- One line per thread: `sender — ask — action — why now`.
- Never send an email unless the user explicitly said "send". Draft instead: show To, Subject and the full body, and stop.
- If a thread contains a deadline, propose the calendar event with a concrete ISO start/end.
