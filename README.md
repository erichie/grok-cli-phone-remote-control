# Grok Phone PWA

Installable **phone chat UI** that talks to a **local [Grok Build](https://x.ai) agent** on your computer (full tools, your workspace). Supports photos, slash commands, durable job queue (phone can lock), usage lookup, and inline Imagine images.

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
| **Phone + host network** | Same Wi‑Fi, [Tailscale](https://tailscale.com), or SSH tunnel |

---

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/erichie/grok-phone-pwa.git
cd grok-phone-pwa

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
grok-phone-pwa listening on http://0.0.0.0:8787
```

Leave this process running (and keep the machine awake while you chat).

### 3. Open on your phone

1. Connect the phone to the **same network** as the host (LAN, Tailscale, or tunnel — see below).
2. Find the host’s IP (System Settings → Network, `ipconfig getifaddr en0` on macOS, or your Tailscale IP).
3. In Safari/Chrome open: `http://<host-ip>:8787`
4. Enter the same `PHONE_CHAT_SECRET`.
5. **Safari → Share → Add to Home Screen** for an installable PWA.

---

## Remote access (recommended)

### Tailscale

Install Tailscale on the host and phone, then open:

```text
http://<tailscale-ip>:8787
```

### SSH tunnel (e.g. Termius)

Forward local port `8787` on the phone/client to `127.0.0.1:8787` on the host, then open:

```text
http://127.0.0.1:8787
```

**Do not** expose port `8787` to the public internet. This app is a LAN/Tailscale personal bridge, not a multi-tenant service.

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

- Prefer **Tailscale** or an **SSH tunnel**; avoid raw public port forwards
- Default bind is `0.0.0.0` (LAN-reachable). Use `PHONE_CHAT_HOST=127.0.0.1` if you only tunnel
- CORS is `*` — any origin can call the API **if** it has the secret (fine for a personal PWA; bad if the secret leaks via XSS or a screenshot)
- Some routes accept `?token=` (SSE / images) so the secret can appear in server logs, browser history, and `Referer`. Prefer the `Authorization: Bearer` header when possible
- Generate a long random secret (`openssl rand -hex 24` or better)
- Do not commit secrets, filled-in LaunchAgent plists, or job logs
- Use a dedicated workspace (`PHONE_CHAT_CWD`) you are comfortable the agent editing

### Operational hardening checklist

1. Strong unique `PHONE_CHAT_SECRET`
2. Tailscale or SSH tunnel (not open WAN)
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
