# Grok CLI Phone Remote Control

Installable **phone remote-control PWA** for your **local [Grok CLI](https://x.ai) / Grok Build agent** (full tools, your workspace). Supports photos, **voice dictation** (live speech→text), slash commands, durable job queue (phone can lock), multi-agent sessions, a **standup feed** and **loops board** (Menu → Standup / Loops), usage lookup, session reconnect, and inline Imagine images.

**Voice dictation at a glance (no paid Tailscale Serve):**

| Path | Needs | What you get |
|------|--------|----------------|
| **Live mic (Web Speech)** | Free self-signed **HTTPS** (default port **8788**) | Tap mic → words appear live; say **bee boop** (or your phrase) to send |
| **Keyboard STT** | Plain `http://` is fine | iPhone keyboard 🎤 — real Apple STT |
| **Voice memo file** | Plain `http://` is fine | Record/pick audio → Mac transcribes |

Setup detail: **[Live mic: free local HTTPS](#live-mic-free-local-https)** below. Agent-oriented setup: [`.grok/skills/phone-remote-control/SKILL.md`](./.grok/skills/phone-remote-control/SKILL.md).

This is **not** a mirror of an open TUI session. It starts its own ACP process:

```text
grok agent --always-approve stdio
```

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js 20+** | `node -v` |
| **Grok CLI** | Installed and on `PATH` as `grok`, or set `GROK_BIN` |
| **Grok login** | Run `grok login` once on the host machine |
| **Phone + host network** | Same Wi‑Fi, or **[Tailscale](https://tailscale.com)** on both devices (recommended off-LAN) |

---

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/erichie/grok-cli-phone-remote-control.git
cd grok-cli-phone-remote-control

# Required: long random shared secret (phone + server must match)
export PHONE_CHAT_SECRET="$(openssl rand -hex 24)"

# Recommended: workspace the agent should work in
export PHONE_CHAT_CWD="$HOME/path/to/your/workspace"

# Optional if `grok` is not on PATH
# export GROK_BIN="$HOME/.grok/bin/grok"
```

Or copy `.env.example` and export the same variables from your shell / process manager.

### 2. Start the bridge (host machine)

```bash
npm start
```

You should see something like:

```text
grok-cli-phone-remote-control
  http:   http://0.0.0.0:8787
  https:  https://0.0.0.0:8788  (free self-signed — live iPhone mic)
  open:   https://<this-mac-ip>:8788
```

Leave this process running (and keep the machine awake while you chat). **Chat works on HTTP; live in-page mic needs the HTTPS URL** (next section).

### First-run macOS permissions (important)

On the **first** times the bridge or Grok agent touches files/folders, **macOS may show permission dialogs for `node`** (and sometimes the Terminal / Grok binary), for example:

- Access to folders in your workspace (`PHONE_CHAT_CWD`)
- Access to Desktop / Documents / Downloads (if the agent opens files there)
- Network / local network (less common)

**Allow** those prompts when they appear. If you click Don’t Allow, tools like shell, read/write, and image paths will fail or hang until you fix access under:

**System Settings → Privacy & Security → Files and Folders** (and **Full Disk Access** only if you intentionally grant it)

You may need to restart `npm start` / the LaunchAgent after changing permissions.

### 3. Open on your phone

1. Put the phone and Mac on a network where they can reach each other:
   - **Same Wi‑Fi**, or  
   - **[Tailscale](https://tailscale.com) on both** (recommended when you’re not on the same LAN — devices talk over a private mesh).
2. Find the host’s IP:
   - LAN: System Settings → Network, or `ipconfig getifaddr en0` on macOS  
   - Tailscale: Machine IP in the Tailscale app / admin console (often `100.x.y.z`)
3. In Safari open:
   - **Chat only / keyboard dictate:** `http://<host-ip>:8787`
   - **Live mic (preferred):** `https://<host-ip>:8788` — see [Live mic: free local HTTPS](#live-mic-free-local-https)
4. Enter the same `PHONE_CHAT_SECRET`.
5. **Safari → Share → Add to Home Screen** for the URL you actually use (HTTP and HTTPS are different homescreen icons).

---

## Live mic: free local HTTPS

iOS only allows the **in-page microphone** (Web Speech / MediaRecorder) in a **secure context**. This bridge dual-listens:

| Scheme | Default port | Purpose |
|--------|--------------|---------|
| `http://` | `8787` (`PHONE_CHAT_PORT`) | Chat, jobs, keyboard STT, voice-memo upload |
| `https://` | `8788` (`PHONE_CHAT_HTTPS_PORT`, default **HTTP+1**) | Live mic + same API |

No paid **Tailscale Serve** plan is required. The Mac generates a **self-signed cert** (OpenSSL) under `~/.grok/phone-pwa-tls/` with SANs for localhost, LAN IPs, Tailscale `100.x` IPs, and MagicDNS names when `tailscale status` is available.

### One-time trust on iPhone (Safari)

1. Start the bridge (`npm start`) and note the **`open: https://…:8788`** line in the banner.
2. On the phone open **exactly that host and port** (Tailscale IP or MagicDNS name if you use Tailscale).
3. Safari will warn that the certificate is not trusted → **Show Details → visit this website** (or Advanced → proceed).
4. Optional but durable: **Settings → General → About → Certificate Trust Settings** and enable full trust for the cert if iOS offers it.
5. Unlock with `PHONE_CHAT_SECRET`, then **Share → Add to Home Screen** from the **HTTPS** tab so the PWA stays on a secure origin.
6. Tap the mic. Words should stream live. Default spoken send phrase: **bee boop** (change under **Menu → Settings**).

### Tips and pitfalls

- **Wrong port is the #1 failure.** Live mic is **`:8788`**, not `:8787`.
- After changing network (new LAN IP / Tailscale), restart the bridge so the cert SAN list regenerates, then reopen the new `https://…` URL.
- Extra hostnames: `PHONE_CHAT_TLS_HOSTS=mac.tailnet.ts.net,other.name`
- Disable TLS entirely: `PHONE_CHAT_TLS=0` (live mic will not work; keyboard / voice memo still do on HTTP).
- From the in-app dictation sheet, **Live mic (free HTTPS)** jumps to the status-reported HTTPS URL when available.
- **Do not** expose `8787` / `8788` on the public internet. LAN or Tailscale only.

### Spoken send phrase

While dictating, say your send phrase **at the end** of the utterance to auto-send (trigger is stripped). Defaults: `bee boop`, `beep boop`, `b boop`. Edit anytime: **Menu → Settings** (saved on that phone only via `localStorage`).

---

## Remote access (recommended: Tailscale)

So the phone and Mac can talk from anywhere without opening your home router:

1. Install [Tailscale](https://tailscale.com) on the **Mac** and the **phone**, sign in to the same account/tailnet.
2. On the Mac, note its **Tailscale IP** (e.g. `100.x.y.z`) or MagicDNS name.
3. Keep `npm start` (or the LaunchAgent) running on the Mac.
4. On the phone open:

```text
# Chat / keyboard STT
http://<mac-tailscale-ip>:8787

# Live mic (trust self-signed cert once)
https://<mac-tailscale-ip>:8788
```

5. Enter `PHONE_CHAT_SECRET` once and add to Home Screen from the URL you want day-to-day (prefer HTTPS if you use the mic).

**Do not** expose ports `8787` / `8788` to the public internet. This app is a personal LAN / Tailscale bridge, not a multi-tenant service.

---

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PHONE_CHAT_SECRET` | **required** | Bearer token for all `/api/*` routes |
| `PHONE_CHAT_PORT` | `8787` | HTTP port |
| `PHONE_CHAT_HTTPS_PORT` | HTTP port + 1 (`8788`) | Free self-signed HTTPS for live mic |
| `PHONE_CHAT_TLS` | on | Set `0` / `false` to disable HTTPS listen |
| `PHONE_CHAT_TLS_HOSTS` | unset | Extra DNS names for cert SAN (comma/space separated) |
| `PHONE_CHAT_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for localhost only) |
| `PHONE_CHAT_CWD` | parent of this app directory | Working directory for the agent |
| `GROK_BIN` | `grok` | Path to the Grok CLI binary |
| `PHONE_CHAT_DEBUG` | unset | If set, log agent stderr |
| `PHONE_CHAT_JOB_IDLE_TIMEOUT_MS` | `300000` (5m) | Kill hung agent turn after no message/thought/tool/terminal activity. In-flight tools and live ACP shells skip this timer. |
| `PHONE_CHAT_JOB_TIMEOUT_MS` | `2700000` (45m) | Absolute max wall time per job |
| `PHONE_CHAT_JOB_AUTO_RETRIES` | `1` | Auto-retry once on agent crash / partial first line |
| `PHONE_CHAT_MAX_BODY_BYTES` | `12582912` (~12MB) | Max request body size (chat + base64 images) |
| `PHONE_CHAT_ALLOW_HOME` | unset | Set to `1` to allow ACP `fs/*` under your full home directory |
| `PHONE_CHAT_FS_ROOTS` | unset | Extra ACP fs roots, separated by `:` `;` or `,` |

---

## Features (high level)

- Chat with the local agent (tools, skills, MCP as configured for Grok on that machine)
- Photo attach (library / camera) → saved under `~/.grok/phone-inbox/`
- **Voice dictation:** live Web Speech on free HTTPS, keyboard STT on HTTP, Mac STT fallback; configurable spoken send phrase
- **Pages:** Menu opens Standup, Agents, Loops, Jobs, and Settings (chat stays the home view)
- **Standup feed:** newspaper-style posts from loops; tap the goal card for the first-principles algorithm
- **Loops board:** host-local catalog; specialists post a card + brief, a synth (CoS) reads those briefs and writes standup
- **Multi-agent:** Menu → Agents to spawn concurrent Grok processes; header **To** chip switches chat; Stop kills that process on the Mac
- Durable jobs under `~/.grok/phone-jobs/` (phone may lock; work continues on the host)
- **Live reply push** via Server-Sent Events (`GET /api/jobs/:id/stream`) so finished answers hit the phone immediately (polling is only a backup). WebRTC is unnecessary for this; SSE is the simple phone↔host push channel.
- **Reset** button: cancel queue + restart agent session
- Instant `/usage` (billing API via host Grok login — not a tool loop)
- Slash catalog for common CLI / tool shortcuts
- Markdown replies; generated Imagine images served inline when available
- Auto-recovery: hung agent turns fall back to a one-shot `grok -p` so a final message still arrives

---

## Standup, loops, and pages

There is no lock-screen push. The phone PWA is the inbox: loops write English posts into a local standup feed, and you open **Menu → Standup** to read them. The hamburger is a set of circular icon buttons. Chat stays the home screen.

| Menu item | What it is |
|-----------|------------|
| **Standup** | Goal pin + chronological posts. Opening the page marks posts read. Unread count is part of the menu badge. |
| **Agents** | Concurrent Grok processes on the Mac. Spawn, rename, stop. Header **To** chip still cycles the send target. |
| **Loops** | What is scheduled, next fire, last run. Specialists write briefs; a synth reads them. **Run now** to fire one. |
| **Jobs** | Durable queue / recovery (Stop & show, Cancel). Not in the top bar. |
| **Settings** | Spoken send phrase (device `localStorage` only). |

### Standup feed

A short newspaper, not a chat dump. Each post is one English card (`standup` / `update` / `alert` / `win`). Tap a card for the long body.

**Pinned goal.** The card at the top shows `north_star` and an optional `first_principle` line (plus `mrr` if you set it). Tap the goal — icon on the left of the title/subtitle — to open the **First principles** page.

**First principles is always in the app.** The five-step algorithm (question every requirement → delete → simplify → accelerate → automate) is committed UI, not optional seed text. Personal *application* of that algorithm belongs in the host seed, never in git.

**Personal pins stay on the host.** Create `~/.grok/phone-standup-seed.json` (never commit this file):

```json
{
  "north_star": "Your north-star goal in one line",
  "first_principle": "How you apply first principles this month",
  "mrr": "Optional extra pin line"
}
```

Missing keys fall back to generic copy (“Set a north-star goal”). The feed store is `~/.grok/phone-standup.db` on Node 22+ (`node:sqlite`), or `~/.grok/phone-standup.json` on Node 20.

**Write a post** (auth same as every `/api/*` route):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/standup/posts \
  -H "Authorization: Bearer $PHONE_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "Morning brief",
    "kind": "standup",
    "title": "Monday",
    "bodyShort": "What moved, what is blocked, one ask.",
    "bodyLong": "Optional long version.",
    "loopId": "morning-brief"
  }'
```

`agentName` and `bodyShort` are required. `kind` is one of `standup`, `update`, `alert`, `win`. If `loopId` matches a loop in the catalog, last-run is stamped on that loop.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/standup` | Pins, posts, `unreadCount` (`?limit=`, default 80) |
| `GET` | `/api/standup/:id` | One post + pins |
| `POST` | `/api/standup/posts` | Create a post; optional `loopId` stamps last run |
| `POST` | `/api/standup/read` | `{ "all": true }` or `{ "ids": ["…"] }` |
| `PATCH` | `/api/standup/pins` | `{ "key": "north_star", "value": "…" }` |

### Loops board

Loops are a **local catalog**, not something checked into the repo. Anyone can set up the same shape:

```bash
cp examples/phone-loops.example.json ~/.grok/phone-loops.json
# edit names, times, timezone — keep personal strategy out of git
```

Then **Menu → Loops**. Each card shows name, description, a human schedule line, next run, and last run. Disabled loops show as paused. If the file is missing, the page tells you to copy the example.

**Specialist vs synth.** Each loop is a `specialist` (default) or a `synth`. Specialists do the work and leave a **short feed card** plus a **detailed brief**. A synth loop (morning brief / chief of staff) does **not** re-research — it reads those briefs and writes the standup. If a specialist has no brief today, the synth must say “no report” for that beat.

```json
{
  "id": "morning-brief",
  "role": "synth",
  "reads": ["ads-health", "inbox-watch"],
  "kind": "standup",
  "prompt": "Quote the specialist briefs. Missing brief → no report."
}
```

`reads` is a list of loop ids. Omit it and a synth reads every other enabled specialist.

**Briefs** live in `~/.grok/phone-briefs.json` (latest per loop). They are also the long body on the standup card — tap a specialist post to read the brief. Creating a standup post with `loopId` upserts that loop’s brief.

**Loops run on the Mac** while the bridge is up (one-shot `grok -p`, not the main chat session). Due slots fire in a ~90s window; a missed morning does **not** catch up at 3pm. **Run now** on the Loops page starts one immediately. Last run stays “Never ran” until a run posts.

The Mac must stay awake. Loop jobs do not appear in the main chat.

Schedule object on each loop:

| `kind` | Fields | Meaning |
|--------|--------|---------|
| `weekdays` | `time` (`HH:MM`), `tz` (IANA) | Mon–Fri at that clock time |
| `daily` | `time`, `tz` | Every day at that clock time |
| `hourly` | `start`, `end`, `days` (`weekdays` or `daily`), `tz` | On the start minute, between start and end |

`enabled: false` hides the next-run time. Default timezone if omitted is `America/New_York`.

`GET /api/loops` returns `{ loops, source: "local"|"missing", hint }`. Each loop includes `role`, `readsFrom`, `lastBriefAt`, `scheduleLabel`, `nextRunAt`, `lastRunAt`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/briefs` | Latest brief per loop |
| `GET` | `/api/briefs/:loopId` | One brief |
| `GET` | `/api/loops/:id/inputs` | What a synth would read right now (present / no report) |
| `POST` | `/api/loops/:id/run` | Run that loop now (202). Does not wait for the agent. |

### Host-only files (do not commit)

| Path | Role |
|------|------|
| `~/.grok/phone-standup.db` or `~/.grok/phone-standup.json` | Feed + pins store |
| `~/.grok/phone-standup-seed.json` | Personal goal / pin seed |
| `~/.grok/phone-loops.json` | Loop catalog (copy from `examples/phone-loops.example.json`) |
| `~/.grok/phone-loops-state.json` | Last-run stamps |
| `~/.grok/phone-briefs.json` | Latest specialist brief per loop |

The committed example (`examples/phone-loops.example.json`) is generic on purpose: morning brief, ads health, inbox watch. Put real loop names and goals only under `~/.grok/`.

---

## Security / threat model

**Treat `PHONE_CHAT_SECRET` like a password.** Anyone who has it can drive an agent **as your host user**.

### What possession of the secret allows

| Surface | Capability |
|--------|------------|
| `grok agent --always-approve` | Unsupervised tool loop (no permission prompts) |
| ACP `terminal/*` | Arbitrary shell commands (cwd/env as the agent requests) |
| ACP `fs/*` | Read/write under allowed roots (see below) |
| Headless fallback (`grok -p`) | Second always-approve path if a turn hangs |
| Chat API | Enqueue work that runs with full agent tools |

This is intentional for a **personal phone remote**. It is **not** safe as:

- A public internet service
- Multi-user / multi-tenant hosting
- A shared household endpoint without a strong secret and network isolation

### Default filesystem roots (ACP `fs/*`)

By default the agent may only use file tools under:

- `PHONE_CHAT_CWD` (workspace)
- System temp (`os.tmpdir()`)
- `~/.grok` (jobs, inbox, Grok config)

**Full home is opt-in:** `PHONE_CHAT_ALLOW_HOME=1`. Paths are checked with symlink-aware resolution so a symlink under an allowed root cannot escape to e.g. `/etc`.

Note: **shell via `terminal/*` is still not chrooted.** Even with narrow fs roots, a command like `cat ~/.ssh/id_rsa` can succeed. Treat shell as full user access.

### Network and auth notes

- Prefer **Tailscale** (or same Wi‑Fi); avoid raw public port forwards
- Default bind is `0.0.0.0` so the phone can reach the Mac on LAN or Tailscale
- CORS is `*` — any origin can call the API **if** it has the secret (fine for a personal PWA; bad if the secret leaks via XSS or a screenshot)
- Some routes accept `?token=` (SSE / images) so the secret can appear in server logs, browser history, and `Referer`. Prefer the `Authorization: Bearer` header when possible
- Generate a long random secret (`openssl rand -hex 24` or better)
- Do not commit secrets, filled-in LaunchAgent plists, or job logs
- Use a dedicated workspace (`PHONE_CHAT_CWD`) you are comfortable the agent editing

### Operational hardening checklist

1. Strong unique `PHONE_CHAT_SECRET`
2. Tailscale on phone + Mac (or same Wi‑Fi — not open WAN)
3. Dedicated `PHONE_CHAT_CWD` project folder
4. Leave `PHONE_CHAT_ALLOW_HOME` unset unless you need it
5. Keep the host machine locked / disk encrypted as usual
6. Run `npm test` and `npm run check:leaks` before publishing changes

### Publishing to the public repo (verify no local / private / secret data)

This project is open source. **Before every commit and push to GitHub**, confirm nothing machine-specific or secret is included:

| Do **not** commit | Examples |
|-------------------|----------|
| Secrets / tokens | Real `PHONE_CHAT_SECRET`, API keys, Bearer tokens, auth cookies |
| Local paths | Absolute home dirs, external volume paths, machine-specific cwd strings |
| Private network | Home LAN addresses, personal VPN hostnames if sensitive |
| Personal identity | Personal email addresses, filled-in LaunchAgent plists, machine labels |
| Runtime data | `~/.grok/phone-jobs`, inbox images, logs, `.env` with real values |
| Standup / loops | `~/.grok/phone-standup.db`, `phone-standup.json`, `phone-standup-seed.json`, `phone-loops.json`, `phone-loops-state.json`, `phone-briefs.json` — personal goals, briefs, last-run stamps |

**Required check (also runs in `npm test` via `test/no-local-leaks.test.mjs`):**

```bash
npm run check:leaks
```

That script fails if tracked sources match forbidden patterns (home/Volumes paths, assigned secrets, personal emails, etc.). Fix any hits before pushing.

Also skim `git diff` / `git status` for untracked local files (`.env`, `*.plist` with real paths, screenshots). Prefer env vars and `*.example` templates only.

---

## Optional: start at login (macOS)

A **placeholder-only** LaunchAgent template lives at:

```text
examples/launchd.plist.example
```

Copy it, replace every `REPLACE_*` value, install under `~/Library/LaunchAgents/`, and load with `launchctl`. **Never commit a filled-in plist.**

---

## Development

```bash
npm start            # same as production entry (node server.mjs)
npm test             # unit tests (includes leak-pattern guard)
npm run check:leaks  # required before push: no local paths / secrets in sources
```

Always run `npm run check:leaks` (or full `npm test`) before pushing to the public remote — see **Publishing to the public repo** above.

Layout:

```text
server.mjs          # HTTP + free HTTPS + ACP bridge + job queue
public/             # PWA (HTML/CSS/JS, service worker, icons)
lib/                # ACP, jobs, dictation, standup, loops, free TLS helpers
.grok/skills/       # project skills (phone setup / best use)
examples/           # templates with placeholders only (incl. phone-loops.example.json)
test/               # node:test suite
scripts/            # repo hygiene helpers
THIRD_PARTY.md      # vendored client library attribution
```

No Node dependencies are required at runtime (stdlib only). Client-side markdown/sanitize libraries are vendored under `public/` — see [THIRD_PARTY.md](./THIRD_PARTY.md).

---

## License

MIT — see [LICENSE](./LICENSE).
