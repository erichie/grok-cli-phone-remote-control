# Grok CLI Phone Remote Control

Installable **phone remote-control PWA** for your **local [Grok CLI](https://x.ai) / Grok Build agent** (full tools, your workspace). Supports photos, slash commands, durable job queue (phone can lock), usage lookup, session reconnect, and inline Imagine images.

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
grok-cli-phone-remote-control listening on http://0.0.0.0:8787
```

Leave this process running (and keep the machine awake while you chat).

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
   - Tailscale: Machine IP in the Tailscale app / admin console
3. In Safari/Chrome open: `http://<host-ip>:8787` (use the **Tailscale IP** when using Tailscale).
4. Enter the same `PHONE_CHAT_SECRET`.
5. **Safari → Share → Add to Home Screen** for an installable PWA.

---

## Remote access (recommended: Tailscale)

So the phone and Mac can talk from anywhere without opening your home router:

1. Install [Tailscale](https://tailscale.com) on the **Mac** and the **phone**, sign in to the same account/tailnet.
2. On the Mac, note its **Tailscale IP** (e.g. `100.x.y.z`).
3. Keep `npm start` (or the LaunchAgent) running on the Mac.
4. On the phone open:

```text
http://<mac-tailscale-ip>:8787
```

5. Enter `PHONE_CHAT_SECRET` once and add to Home Screen if you like.

**Do not** expose port `8787` to the public internet. This app is a personal LAN / Tailscale bridge, not a multi-tenant service.

---

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PHONE_CHAT_SECRET` | **required** | Bearer token for all `/api/*` routes |
| `PHONE_CHAT_PORT` | `8787` | HTTP port |
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
npm start          # same as production entry (node server.mjs)
npm test           # unit tests
npm run check:leaks  # fail if tracked sources look machine-specific
```

Layout:

```text
server.mjs          # HTTP + ACP bridge + job queue
public/             # PWA (HTML/CSS/JS, service worker, icons)
lib/                # shared ACP demux, job stream, fs, terminal helpers
examples/           # templates with placeholders only
test/               # node:test suite
scripts/            # repo hygiene helpers
THIRD_PARTY.md      # vendored client library attribution
```

No Node dependencies are required at runtime (stdlib only). Client-side markdown/sanitize libraries are vendored under `public/` — see [THIRD_PARTY.md](./THIRD_PARTY.md).

---

## License

MIT — see [LICENSE](./LICENSE).
