# Grok CLI Phone Remote Control

Installable **phone remote-control PWA** for your **local [Grok CLI](https://x.ai) / Grok Build agent** (full tools, your workspace). Supports photos, **voice dictation** (live speech→text), slash commands, durable job queue (phone can lock), multi-agent sessions, usage lookup, session reconnect, and inline Imagine images.

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
6. Tap the mic. Words should stream live. Default spoken send phrase: **bee boop** (change under **Menu → Voice send**).

### Tips and pitfalls

- **Wrong port is the #1 failure.** Live mic is **`:8788`**, not `:8787`.
- After changing network (new LAN IP / Tailscale), restart the bridge so the cert SAN list regenerates, then reopen the new `https://…` URL.
- Extra hostnames: `PHONE_CHAT_TLS_HOSTS=mac.tailnet.ts.net,other.name`
- Disable TLS entirely: `PHONE_CHAT_TLS=0` (live mic will not work; keyboard / voice memo still do on HTTP).
- From the in-app dictation sheet, **Live mic (free HTTPS)** jumps to the status-reported HTTPS URL when available.
- **Do not** expose `8787` / `8788` on the public internet. LAN or Tailscale only.

### Spoken send phrase

While dictating, say your send phrase **at the end** of the utterance to auto-send (trigger is stripped). Defaults: `bee boop`, `beep boop`, `b boop`. Edit anytime: **Menu → Voice send** (saved on that phone only via `localStorage`).

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
| `PHONE_CHAT_JOB_IDLE_TIMEOUT_MS` | `90000` (90s) | Kill hung agent turn after no message/tool progress (thoughts alone do not reset the timer) |
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
- **Multi-agent:** Menu → spawn concurrent Grok processes; header **To** chip switches chat; Stop kills that process on the Mac
- Durable jobs under `~/.grok/phone-jobs/` (phone may lock; work continues on the host)
- **Live reply push** via Server-Sent Events (`GET /api/jobs/:id/stream`) so finished answers hit the phone immediately (polling is only a backup). WebRTC is unnecessary for this; SSE is the simple phone↔host push channel.
- **Reset** button: cancel queue + restart agent session
- Instant `/usage` (billing API via host Grok login — not a tool loop)
- Slash catalog for common CLI / tool shortcuts
- Markdown replies; generated Imagine images served inline when available
- Auto-recovery: hung agent turns fall back to a one-shot `grok -p` so a final message still arrives

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
lib/                # ACP, jobs, dictation, free TLS helpers
.grok/skills/       # project skills (phone setup / best use)
examples/           # templates with placeholders only
test/               # node:test suite
scripts/            # repo hygiene helpers
THIRD_PARTY.md      # vendored client library attribution
```

No Node dependencies are required at runtime (stdlib only). Client-side markdown/sanitize libraries are vendored under `public/` — see [THIRD_PARTY.md](./THIRD_PARTY.md).

---

## License

MIT — see [LICENSE](./LICENSE).
