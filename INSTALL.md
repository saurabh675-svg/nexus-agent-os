# Install Nexus on Windows

A clean, step-by-step install. No coding required. Budget 10 minutes, plus model download time.

## Recommended: packaged Windows desktop app

1. Run `Nexus Setup 7.2.0.exe` from `dist-electron\release`.
2. Choose an install location and finish setup. The installer is per-user; administrator access is
   not required.
3. Launch **Nexus** from the Start menu.
4. Open **Connections** and choose local Ollama or Cloud API. Enter the endpoint, model, and API key,
   then test the connection. Provider presets are under **More options**. Local Ollama needs no key.
   Cloud model keys entered in the desktop app are encrypted with Windows secure storage; no Vault
   setup is needed for model APIs.
5. Test the selected provider. Nexus does not automatically switch providers when one fails.

Desktop settings and runtime data are stored separately under the current Windows user's
application-data folder, not inside the installer. To build from source, install Node.js 20+, then
run `npm install` and `npm run dist:win` from the project folder. The installer is written to
`dist-electron\release\`.

The browser/server developer mode can still run with `npm start`; keys entered there stay in memory
only and are lost when Nexus closes.

---

## What you need

| | Requirement | Notes |
|---|---|---|
| OS | Windows 10 or 11 (64-bit) | test it on 11 first |
| Runtime | **Node.js 20 or newer** | one installer, 30 MB, free |
| Space | 300 MB free, +4 GB if you use a local model | a cloud API key needs no space |
| Browser | Chrome or Edge | already on your PC |
| Optional | Google, Kaggle, Discord, GitHub accounts | only for those features |

---

## Step 1 — Install Node.js

1. Go to **https://nodejs.org** and download the **LTS** installer (`.msi`).
2. Run it, click Next through everything, accept the defaults.
3. Verify: press `Win+R`, type `powershell`, press Enter, then run:

```
node -v
```

You should see something like `v22.x.x`. If you see an error, the installer did not finish — run it again.

---

## Step 2 — Put the folder somewhere sensible

Unzip `nexus-1.0.0.zip` and move the `nexus-1.0.0` folder to:

```
C:\Nexus
```

**Do not** put it in `C:\Program Files` — Windows protects that folder and the app needs to write
its own data next to itself. `C:\Nexus` is right.

You can rename the folder to anything you like (`C:\AgentOS`, etc.). Just keep it out of Program Files.

---

## Step 3 — Run the installer (creates a shortcut)

Double-click **`install.cmd`** inside the folder.

It checks that Node is present, then puts a **Nexus** shortcut on your Desktop. That is the only thing
it installs — no registry keys, no services, no admin rights.

Then double-click the new **Nexus** shortcut. A black window opens and your browser opens
`http://127.0.0.1:8787`.

> The black window **is** the program. Keep it open. Closing it stops everything.
> If Windows Firewall asks, you can safely click Cancel — the server only listens on your own machine
> (`127.0.0.1`) and never accepts connections from the network.

### Optional desktop window

The browser launcher above remains dependency-free. From the project folder, run `npm install` once
and then `npm run desktop` for the Electron window. Build a Windows installer with `npm run dist:win`;
it is written to `dist-electron`. Packaged user settings and browser data are stored in the user's
application-data directory and are not included in the installer.

---

## Step 4 — Give it a model (the only real decision)

Nexus is the body; the model is the intelligence.

### Option A — local and free

In the black window, run:

```
ollama pull qwen2.5:7b
```

If `ollama` is not recognised, install it first from **https://ollama.com/download**.

Then in Nexus: **Connections → Local Ollama**. Enter the local model name and endpoint, then select
**Save and test**.

### Option B — cloud model (faster, small cost)

1. Get an API key: **Groq** (free tier), **DeepSeek** (cheap), **OpenRouter**, or **OpenAI**.
2. In Nexus: **Connections → Cloud API**. Enter the provider endpoint, model ID, and API key. For
   presets, open **More options → Add from a preset**. No Vault creation or unlock is required.
3. Save and test the connection. Examples:

| Provider | Base URL | Model example |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | whatever you loaded |

### Check it

Open the **✚ Doctor** app. Every line should say `pass`. Anything that says `fail` shows the exact fix
underneath it.

---

## Step 5 — Optional: the encrypted Vault

The Vault is optional and is not used for model API keys. Use it only for credentials or backups
that you explicitly choose to store in Nexus.

1. Open **⛁ Vault** → type a long passphrase twice → **Create**.
2. Add entries: Discord, Gmail, and — useful for you — the *third* Gmail you used on each site.

**The passphrase is never stored.** If you forget it, the entries are unrecoverable. That is the
design. Write it on paper once.

---

## Step 6 — Optional integrations

Do these only when you want them. Each one is independent.

### Google (Gmail, Calendar, Drive, Sheets) — 5 minutes

1. Go to **https://console.cloud.google.com** → create a project (any name).
2. **APIs & Services → Library**: enable **Gmail API**, **Google Calendar API**, **Google Drive API**,
   **Google Sheets API**, **Google Docs API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill the 3 required fields, then
   add yourself under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under *Authorised redirect URIs* add exactly:

```
http://127.0.0.1:8787/oauth/callback
```

5. Copy the **Client ID** and **Client secret** into Nexus **Connections → Google** and save them.
6. Click **connect google** in the Connections card → sign in → the tab closes itself when done.

### Kaggle — 2 minutes

1. **https://www.kaggle.com/settings/account** → **Create New Token**. A `kaggle.json` downloads.
2. In **Connections → Kaggle**, click **detect kaggle.json** to import it from Downloads, or enter
   the `username` and `key` values manually.
3. Click **save + test Kaggle**. Nexus writes `%USERPROFILE%\.kaggle\kaggle.json` for CLI use.

### Discord bot — 5 minutes

1. **https://discord.com/developers/applications** → **New Application** → name it.
2. **Bot** tab → **Reset Token** → copy it.
3. On the same page, scroll down and enable **MESSAGE CONTENT INTENT** (required, the bot cannot read
   messages without it).
4. **OAuth2 → URL Generator**: scope `bot`, permissions **Send Messages** + **Read Message History**.
   Open the generated URL to invite it to your server.
5. In Nexus **◉ Community**: paste the token, and paste your **admin channel ID** (right-click the
   channel → Copy Channel ID, after enabling Developer Mode in Discord settings).
6. **save** → **test token** → **start bot**.

### GitHub (optional, for PRs and bounties)

**https://github.com/settings/tokens** → *Fine-grained token* → read access to public repos is enough.
Paste it into **⚙ Settings** (GitHub field) — used by **◭ Intel** for bounty search and by the `github`
tool for pull requests.

---

## Step 7 — First real use

Open **◈ Nexus** and type one of these:

> "Run `python gee_automation.py check` in the background and tell me when it ends."

> "Find open Kaggle competitions with cash prizes, rank them by how fast I could submit."

> "I have 8 hours a week to earn extra money. What should I do?"

Open **▦ Lab** to watch long jobs live, and **❋ Brain → sync other agents** to import what Codex and
Claude Code already did on this PC.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `node` is not recognised | Node not installed, or terminal opened before install | Reinstall Node LTS, open a **new** PowerShell window |
| `EADDRINUSE` / port 8787 busy | another Nexus is already running | Close the other black window, or launch with `set PORT=8788 && node server.js` |
| Browser opens but page is blank | server crashed | Read the black window — the last red line is the error |
| `Ollama unreachable` | Ollama not running | Run `ollama serve`, or switch to an API key |
| `model not found` | model not pulled | `ollama pull qwen2.5:7b`, then refresh model list in Settings |
| Browser panel says "not running" | Chrome not launched by Nexus | Click **launch chrome** in the ◐ Browser app |
| Chrome says "profile in use" | you opened Chrome normally with the same profile | Close that Chrome window, click launch again |
| Gmail: `redirect_uri_mismatch` | redirect URI differs by one character | It must be exactly `http://127.0.0.1:8787/oauth/callback`, not `localhost`, not `https` |
| Discord: "Missing Access" then no replies | MESSAGE CONTENT INTENT is off | Developer Portal → Bot → enable it → restart bot |
| Everything is slow | model too big for your RAM | Use a 3B–7B model, or a cloud API key |
| Antivirus blocks the zip | unsigned `.cmd`/`.js` files | Allow the folder; the app is plain text you can read |

---

## Updating

Unzip the new version over the old folder, **keeping `data\`**. That folder holds your brain, vault,
tasks, settings and workspace — the program itself is replaceable, your data is not.

## Moving to a new PC

Copy the whole folder including `data\`. Then:
- Your brain, tasks, skills and workspace come along.
- The vault travels encrypted — same passphrase opens it.
- You must re-authorise Google (the OAuth token is tied to this machine's redirect) and re-paste any
  API keys.

## Backing up

**Vault app → Backup now** writes an encrypted bundle into a hidden Google Drive folder. Without Google
connected it writes to `data\backups\`. Either way the file is encrypted before it leaves the process —
Drive never sees a password.

## Uninstalling

Delete the folder and the Desktop shortcut. Nothing is hidden elsewhere:
- data → `data\`
- Chrome profile used by the browser panel → `data\chrome-profile\`
- logs → `data\logs\`
- Kaggle credentials → `%USERPROFILE%\.kaggle\kaggle.json`

## Security, in one paragraph

The server listens on `127.0.0.1` only. Cloud provider keys entered in the Windows desktop app are
protected with Windows secure storage; keys entered in browser/server developer mode are session-only.
Do not copy or share runtime data folders. The optional Vault continues to encrypt its own entries.
Keep the permission mode on **Ask** until you have watched the agent work for a week.
