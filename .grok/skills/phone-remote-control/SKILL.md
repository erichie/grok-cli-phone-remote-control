---
name: phone-remote-control
description: >
  Set up and operate the Grok CLI Phone Remote Control PWA (grok-phone-pwa /
  erichie/grok-cli-phone-remote-control): free local HTTPS live mic, Tailscale,
  secret, multi-agent, standup feed, loops board, voice send phrase, and publish
  hygiene. Use when the user asks about phone remote, PWA mic, free HTTPS 8788,
  self-signed cert, dictation, bee boop, standup, loops, PHONE_CHAT_*, or runs
  /phone-remote-control.
---

# Phone remote control (setup + best use)

Authoritative user docs: repo root `README.md`. Prefer this skill when **doing** setup, diagnosing mic/HTTPS, seeding standup/loops, or teaching the user the happy path.

## What this product is

- Installable phone PWA that drives a **local** Grok agent via ACP (`grok agent --always-approve stdio`).
- **Not** a mirror of an open TUI session — its own process(es) on the Mac.
- Personal LAN / **Tailscale** bridge only — never a public multi-tenant service.

## First-time setup (host Mac)

1. Clone public repo `erichie/grok-cli-phone-remote-control` (or local `grok-phone-pwa` checkout).
2. Require Node **20+**, Grok CLI on `PATH` (or `GROK_BIN`), `grok login` already done.
3. Export (never commit real values):

```bash
export PHONE_CHAT_SECRET="$(openssl rand -hex 24)"
export PHONE_CHAT_CWD="$HOME/path/to/workspace"   # dedicated folder preferred
# optional:
# export PHONE_CHAT_HTTPS_PORT=8788
# export PHONE_CHAT_TLS_HOSTS=mac.tailnet-name.ts.net
```

4. `npm start` — leave running; keep Mac awake while chatting.
5. Banner should show both **http :8787** and **https :8788** (unless `PHONE_CHAT_TLS=0`).
6. First-run macOS: **Allow** Node folder access prompts; fix under System Settings → Privacy & Security → Files and Folders if denied.

### Ports (memorize)

| Port | Scheme | Use |
|------|--------|-----|
| **8787** | `http://` | Chat, jobs, keyboard STT, voice-memo upload |
| **8788** | `https://` | **Live mic** (Web Speech) + same APIs |

Default HTTPS port is HTTP+1. Override with `PHONE_CHAT_HTTPS_PORT`.

## Phone network

Prefer **Tailscale** on Mac + phone (same tailnet). Else same Wi‑Fi.

- Tailscale IP often `100.x.y.z` or MagicDNS name.
- Open the host IP the phone can route to — not `127.0.0.1` from the phone.

## Live mic: free self-signed HTTPS (no paid Tailscale Serve)

iOS blocks in-page mic on plain HTTP. The bridge dual-listens with a free cert under `~/.grok/phone-pwa-tls/` (SAN: localhost, LAN, Tailscale 100.x, MagicDNS when `tailscale status` works).

### User steps (do in order)

1. Confirm banner: `open: https://<mac-ip-or-magicdns>:8788`
2. Safari → **that exact HTTPS URL** (wrong port = silent failure).
3. Trust warning → Show Details → proceed / visit website.
4. Optional: Settings → General → About → Certificate Trust Settings → enable trust.
5. Enter `PHONE_CHAT_SECRET` → **Share → Add to Home Screen from the HTTPS page**.
6. Tap mic → live text. End with **bee boop** (or Menu → Settings) to auto-send.

### Diagnose live mic

| Symptom | Likely fix |
|---------|------------|
| No mic prompt / Speech unavailable | On `http://` or wrong port — switch to `https://…:8788` |
| Cert error / won’t load | Wrong host vs SAN; restart bridge after IP change; use Tailscale IP/name shown in banner |
| Mic works in Safari but not Home Screen icon | Icon was saved from HTTP — re-add from HTTPS tab |
| Still need voice without HTTPS | **Keyboard dictate** (iPhone 🎤) or **Voice memo file** (Mac STT) |

Disable TLS only if intentional: `PHONE_CHAT_TLS=0` (live mic gone; HTTP paths remain).

## Dictation modes (prefer in this order)

1. **Browser Web Speech on HTTPS** — live interim text; no Mac STT.
2. **Keyboard STT** — works on HTTP; real Apple STT.
3. **MediaRecorder / voice memo → Mac** — `POST /api/dictation` when browser STT missing.

Spoken send: phrase only matches **at end** of utterance; mid-sentence “bee boop” does not send. Defaults include STT aliases (`beep boop`, `b boop`). Stored on device (`localStorage`), not on the Mac.

## Pages (menu)

Hamburger is circular icon buttons. Chat stays home.

| Open | Do this |
|------|---------|
| Standup | Daily paper: goal pin + English loop posts. Opening marks read. Badge includes unread. |
| Agents | Spawn / rename / stop concurrent Mac processes. Header **To** chip still cycles send target. |
| Loops | Catalog + next run + last run. Specialists write briefs; a synth reads them. **Run now** or the Mac ticker. |
| Jobs | Queue recovery. Queued: Send now / Edit / Delete (chat: long-press the bubble). Running: Stop & show / Cancel. |
| Settings | Spoken send phrase (`localStorage` on that phone). |

Full tables and curl: repo `README.md` → **Standup, loops, and pages**.

## Standup + loops (host setup)

Personal goals and real loop names stay under `~/.grok/`. Never commit them.

1. Optional pins — create `~/.grok/phone-standup-seed.json` with `north_star`, optional `first_principle` and `mrr`. Restart the bridge after creating it so pins seed once.
2. Copy the catalog:

```bash
cp examples/phone-loops.example.json ~/.grok/phone-loops.json
```

3. Edit ids, names, descriptions, `schedule.kind` (`weekdays` / `daily` / `hourly`), times, and IANA `tz`. Set `enabled: false` to pause.
4. Specialists (`role` omitted or `specialist`) write a short card + a long **brief**. A synth (`role: "synth"`, `reads: ["other-id"]`) runs **after** them and only summarizes those briefs. Put the synth later (e.g. 08:20 if specialists are 08:00–08:15).
5. Reload **Menu → Loops**. Empty page + hint means the file is missing or invalid JSON. **Run now** fires one loop immediately.
6. Posts: `POST /api/standup/posts` with `agentName`, `bodyShort`, optional `bodyLong` / `loopId`. `loopId` stamps last run and upserts `~/.grok/phone-briefs.json`. Kinds: `standup` | `update` | `alert` | `win`.

**First principles** (5-step algorithm) is always in the PWA — tap the standup goal card. Do not replace those steps with seed text. Seed `first_principle` is only the subtitle under the goal.

**Loops run on the Mac** (`grok -p`, not the main chat) while the bridge is up. Due window is ~90s — no afternoon catch-up. A synth prompt includes today’s briefs or `NO REPORT TODAY`; it must not invent missing numbers.

Host-only (gitignore / do not add): `phone-standup.db` or `.json`, `phone-standup-seed.json`, `phone-loops.json`, `phone-loops-state.json`, `phone-briefs.json`.

Extra-agent chats stay on that agent. Do not rebuild the main conversation from every `phone-jobs` file.

## Security rules (always)

- Treat `PHONE_CHAT_SECRET` as a password (full agent + shell as host user).
- Do **not** port-forward 8787/8788 to the open internet.
- Prefer Tailscale or same Wi‑Fi; strong random secret; dedicated `PHONE_CHAT_CWD`.
- Before public push: `npm test` and `npm run check:leaks` — no real secrets, home paths, LAN identities, personal standup seeds, or personal loop catalogs in the tree.

## When helping the user

- Give **concrete URLs** with their IP/port from the banner when known; never invent private secrets.
- Prefer free HTTPS path for “mic doesn’t work on iPhone” over paid Serve.
- Point at `README.md` for full tables; use this skill for the operational checklist.
- Standup/Loops 404 or empty after a code change: the LaunchAgent is still on the old `server.mjs` — restart it.
- Loops page empty: confirm `~/.grok/phone-loops.json` exists (copy the example). Last run “Never ran” until a scheduled or **Run now** job posts.
- Synth standup is thin / invented: specialists have no fresh brief. Check `GET /api/loops/:id/inputs` and `~/.grok/phone-briefs.json`.
- Publish hygiene: only placeholders in examples; never commit `~/.grok/phone-*` runtime data or personal goals.
