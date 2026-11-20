# START HERE

You do not need to know how to code. Follow these five steps in order. Total time: about six minutes,
plus however long a model download takes.

---

## 1. Start it

Double-click **`start.cmd`** in this folder.

A black window opens and says `Nexus 7 running at http://127.0.0.1:8787`, and your browser opens by
itself. That black window **is** the program — keep it open while you use Nexus. Closing it stops
everything.

To use it again tomorrow: double-click `start.cmd`.

If you prefer a dedicated desktop window, install the optional desktop dependencies with `npm install`
and launch it with `npm run desktop`. The packaged app uses its own data folder; it does not bundle
your browser profile, settings, or credentials.

---

## 2. Give it a brain (the only step that needs a decision)

Nexus is the body. The model is the intelligence. Pick one:

**Option A — free and fully offline.** Install Ollama, then in the black window run:

```
ollama pull qwen2.5:7b
```

Then in Nexus: gear icon → Provider `Ollama (local)` → model `qwen2.5:7b` → Save.

**Option B — a cloud model (faster, costs a little).** Get an API key from Groq, DeepSeek, OpenAI or
OpenRouter. In Nexus: gear icon → Provider `OpenAI-compatible` → paste the base URL and the key →
Save. Groq and DeepSeek both have free tiers and are quick.

If you are unsure: **do Option A with `qwen2.5:7b`**. It runs on your machine, costs nothing, and
nothing you type ever leaves the PC.

Open the **Doctor** app at any time — it tells you in plain English what is broken and how to fix it.

---

## 3. Make a passphrase for the Vault (only if you want saved passwords)

Open the **Vault** app → type a long passphrase twice → Create.

- It encrypts everything with that passphrase. **Nobody can recover it if you forget it** — not me,
  not Google, nobody. That is what makes it safe.
- Use it for the accounts you keep forgetting: Discord, Gmail, upwork, whatever.
- It never reads the passwords Chrome already saved. You type in the ones that matter.

Then open **Brain** → "sync other agents". It reads what Codex and Claude Code already did on this
machine and remembers it. Your brain now has context.

---

## 4. Use it

Open the **Nexus** app (the diamond icon). Type like you are talking to a smart assistant who can
actually use your computer. Real examples:

> "What Kaggle competitions are open with cash prizes? Rank them by how fast I could submit
> something."

> "Write and run a Python script that checks which files in this folder are PowerPoint decks, and
> list them with their slide counts."

> "Every morning at 9, check my calendar and email me a plan for the day."

> "Find my unread mail from the last two days and tell me which ones actually need a reply."

> "Push the kernel in D:\kaggle\my-notebook to Kaggle and tell me when it finishes."

> "I have 8 hours a week to earn extra money. What should I do?"

For a big messy question, press **Ctrl+K**, type the question, press Enter. It runs a team of
sub-agents in parallel and gives you one answer.

---

## 5. The safety rule you need to understand

Nexus has four permission modes, shown in the chat toolbar. Out of the box it is **Ask**:

- Searching, reading files, reading your mail → **happens immediately**.
- Writing a file, running a command, sending an email, clicking in your browser → **it stops and
  asks you**, with a card showing exactly what it wants to do.

You choose: Allow once / Allow this session / Always allow / Deny.

Two things are **never** allowed, in any mode: deleting your files destructively, and touching system
folders. There is also a full log of every action in the **Safety** app, and every file it edits is
backed up first so you can restore it with one click.

Do not switch to **Full** mode until you have watched it work for a week. There is no prize for speed.

---

## What the icons mean

| Icon | App | What it is for |
|---|---|---|
| ◈ | Nexus | talk to the agent |
| ⌕ | Search | web search without the agent |
| ◐ | Browser | let the agent drive Chrome — **tabs live inside this panel** |
| ⬡ | Clusters | several agents think in parallel |
| ◷ | Automations | "every morning at 9, do X" |
| ✉ | Gmail | read and send mail |
| K | Kaggle | competitions and kernels |
| ✦ | Skills | instructions the agent always follows |
| ▮ | Terminal | run a command yourself |
| ▦ | Lab | run long jobs (GEE, Kaggle, decks) with a live log, and see files they produced |
| ❖ | Memory | short notes |
| ▤ | Files | browse files |
| ⛨ | Safety | permissions, audit log, undo |
| ⛁ | Vault | encrypted passwords |
| ◉ | Community | the Discord bot |
| ❋ | Brain | what it knows about you |
| ◭ | Intel | ways to earn, and the rules that keep accounts alive |
| ✚ | Doctor | what is broken and how to fix it |
| ⚙ | Settings | keys and accounts |

---

## If something goes wrong

1. Open **Doctor**. It names the exact problem and the fix.
2. Still stuck: close the black window, double-click `start.cmd` again.
3. Your data is not in the app, it is in the `data` folder next to it:
   - `brain.jsonl` — everything it learned
   - `vault.json` — your encrypted passwords
   - `settings.json` — your keys
   - `workspace` — files the agent created

Back those up and you can never lose the setup. The **Vault** app has a "Backup now" button that puts
an encrypted copy in your Google Drive the moment you connect Google.

---

## One honest caveat

It will not win a Kaggle competition for you. What it does is remove the boring 90%: watching the
leaderboard, polling runs, reading logs, retrying, formatting submissions, writing the report. Your
judgement still decides what to try. That is true of Codex, Claude and Z.ai as well — the difference
here is that this one runs on your machine, knows your history, and asks before it touches anything.


---

## Optional: Plugins (6.9)

Copy `docs/examples/hello-plugin` to `data/plugins/hello`, restart Nexus, open the **Plugins** app, then ask:

> call the hello plugin tool and greet me

See `docs/PLUGIN-SDK.md` and `docs/SANDBOX.md` before installing third-party plugins.
