/**
 * Phone PWA bridge → local `grok agent --always-approve --effort medium stdio` (ACP).
 *
 * Env:
 *   PHONE_CHAT_SECRET   required shared secret (Authorization: Bearer …)
 *   PHONE_CHAT_PORT     default 8787
 *   PHONE_CHAT_HOST     default 0.0.0.0 (LAN) — use 127.0.0.1 for localhost only
 *   PHONE_CHAT_CWD      default process.cwd() parent or GROK_PHONE_CWD
 *   GROK_BIN            path to grok binary (default: grok on PATH)
 *
 *   npm start
 *   # on phone (same Wi‑Fi / Tailscale): http://<mac-ip>:8787
 */
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rename,
  unlink,
} from "node:fs/promises";
import { join, extname, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import {
  applySessionUpdate,
  applyPromptDone,
  forceTerminalizeJob,
  isTerminalJobStatus,
  hasInFlightWork,
} from "./lib/job-stream.mjs";
import {
  isJobSealed,
  sealJob,
  isShortFollowUp,
  buildRecentContextBlock,
  isQueuedWaitingJob,
  applyQueuedJobText,
  promoteQueuedJob,
} from "./lib/job-ownership.mjs";
import {
  emptyConversation,
  loadConversation,
  saveConversation,
  upsertJobInConversation,
  removeJobFromConversation,
  jobBelongsToMainConversation,
  isMainAgentId,
  conversationToMessages,
  rebuildConversationFromJobs,
  buildTranscriptPromptContext,
  startFreshConversation,
} from "./lib/conversation.mjs";
import { TerminalManager } from "./lib/terminal-manager.mjs";
import { defaultAllowedRoots, isPathAllowed } from "./lib/fs-handlers.mjs";
import { AcpLineHandler } from "./lib/acp-line-handler.mjs";
import {
  createAgentRegistry,
  killProcessTree,
} from "./lib/agent-registry.mjs";
import {
  processDictationAudio,
  normalizeDictationSuccess,
} from "./lib/dictation.mjs";
import { ensurePhoneTlsMaterial, listLanIPv4 } from "./lib/phone-tls.mjs";
import { openStandup, getFeedPayload, readLocalStandupSeed } from "./lib/standup.mjs";
import {
  readLocalLoops,
  readLoopState,
  listLoops,
  recordLoopRun,
  isLoopDue,
} from "./lib/loops.mjs";
import { readAllBriefs, readBrief, upsertBrief } from "./lib/briefs.mjs";
import { loadAgentRoster, saveAgentRoster } from "./lib/agents-store.mjs";
import {
  parseLoopReport,
  gatherSynthInputs,
  buildSpecialistPrompt,
  buildSynthPrompt,
} from "./lib/loop-report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PHONE_CHAT_PORT || 8787);
/** Free self-signed HTTPS for live iPhone mic (no paid Tailscale Serve). */
const HTTPS_PORT = Number(
  process.env.PHONE_CHAT_HTTPS_PORT ||
    (Number.isFinite(PORT) ? PORT + 1 : 8788)
);
const TLS_DISABLED =
  process.env.PHONE_CHAT_TLS === "0" ||
  process.env.PHONE_CHAT_TLS === "false";
const HOST = process.env.PHONE_CHAT_HOST || "0.0.0.0";
const SECRET = (process.env.PHONE_CHAT_SECRET || "").trim();
const CWD =
  process.env.PHONE_CHAT_CWD ||
  process.env.GROK_PHONE_CWD ||
  join(__dirname, ".."); // default: parent of this app (set PHONE_CHAT_CWD to override)
const GROK_BIN = process.env.GROK_BIN || "grok";
/** Phone ACP + headless fallback always start at medium (not high). */
const AGENT_REASONING_EFFORT = "medium";
const INBOX = join(homedir(), ".grok", "phone-inbox");
const JOBS_DIR = join(homedir(), ".grok", "phone-jobs");
/** Durable conversation transcript + last ACP session id (survives bridge restart). */
const CONVERSATION_PATH = join(homedir(), ".grok", "phone-conversation.json");
/** Daily standup feed (SQLite on Node 22+). */
const STANDUP_PATH = join(homedir(), ".grok", "phone-standup.db");
/** Host-only pins (north star, etc.). Not in the public repo. */
const STANDUP_SEED_PATH = join(homedir(), ".grok", "phone-standup-seed.json");
/** Host-only loop catalog. Copy examples/phone-loops.example.json here. */
const LOOPS_PATH = join(homedir(), ".grok", "phone-loops.json");
const LOOPS_STATE_PATH = join(homedir(), ".grok", "phone-loops-state.json");
/** Latest specialist brief per loop. Host-only. */
const BRIEFS_PATH = join(homedir(), ".grok", "phone-briefs.json");
/** Extra-agent roster + ACP session ids so a bounce restores Budgey etc. */
const AGENTS_PATH = join(homedir(), ".grok", "phone-agents.json");
const AUTH_PATH = join(homedir(), ".grok", "auth.json");
/** Live credit/usage (same source as TUI /usage). */
const BILLING_CREDITS_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const BILLING_MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const USER_SUB_URL =
  "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
/**
 * Progress silence: no message / thought / tool / terminal activity for this
 * long → treat as hung and recover. In-flight tools and live ACP terminals
 * skip the idle kill (long builds are not hangs). Absolute max wall time still
 * applies. Override with PHONE_CHAT_JOB_IDLE_TIMEOUT_MS.
 */
/** No stream/RPC activity for this long → hang recovery (default 5 min). */
const JOB_IDLE_TIMEOUT_MS = Number(
  process.env.PHONE_CHAT_JOB_IDLE_TIMEOUT_MS || 5 * 60 * 1000
);
/** Max JSON/body size for chat uploads (images base64 included). */
const MAX_BODY_BYTES = Number(
  process.env.PHONE_CHAT_MAX_BODY_BYTES || 12 * 1024 * 1024
);
const JOB_MAX_TIMEOUT_MS = Number(
  process.env.PHONE_CHAT_JOB_TIMEOUT_MS || 45 * 60 * 1000
);
/** Auto-retry once when the agent dies or returns only a partial first line. */
const JOB_AUTO_RETRIES = Number(process.env.PHONE_CHAT_JOB_AUTO_RETRIES || 1);

const standup = openStandup(STANDUP_PATH, {
  seed: readLocalStandupSeed(STANDUP_SEED_PATH),
});

if (!SECRET) {
  console.error(
    "Set PHONE_CHAT_SECRET (shared password for the phone app).\n  export PHONE_CHAT_SECRET='your-long-random-secret'"
  );
  process.exit(1);
}

mkdirSync(INBOX, { recursive: true });
mkdirSync(JOBS_DIR, { recursive: true });

// ─── Local billing / usage (do NOT send /usage to the agent) ─────────────────

function unwrapVal(v) {
  if (v == null) return null;
  if (typeof v === "object" && "val" in v) return v.val;
  return v;
}

function centsToUsd(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return null;
  return (Number(cents) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 1)}%`;
}

function fmtWhen(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return String(iso);
  }
}

async function readGrokAccessToken() {
  try {
    const raw = await readFile(AUTH_PATH, "utf8");
    const data = JSON.parse(raw);
    const entry = Object.values(data || {})[0];
    if (!entry || typeof entry !== "object") return null;
    return entry.key || entry.access_token || null;
  } catch {
    return null;
  }
}

async function fetchJsonAuth(url, token, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "GrokCLI/phone-pwa",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Instant usage report (TUI /usage equivalent). Never routes through the agent.
 */
async function formatUsageReport() {
  const token = await readGrokAccessToken();
  if (!token) {
    return [
      "## Usage",
      "",
      "No Grok login found on this Mac (`~/.grok/auth.json`).",
      "In Terminal run: `grok login`",
      "",
      "Manage online: https://grok.com/?_s=billing",
    ].join("\n");
  }

  const [creditsR, monthlyR, userR] = await Promise.allSettled([
    fetchJsonAuth(BILLING_CREDITS_URL, token),
    fetchJsonAuth(BILLING_MONTHLY_URL, token),
    fetchJsonAuth(USER_SUB_URL, token),
  ]);

  const lines = ["## Usage", ""];
  const user = userR.status === "fulfilled" ? userR.value : null;
  if (user) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "—";
    lines.push(`- **Account:** ${user.email || "—"} (${name})`);
    if (user.subscriptionTier) {
      lines.push(`- **Plan:** ${user.subscriptionTier}`);
    }
    if (user.hasGrokCodeAccess != null) {
      lines.push(`- **Grok Code access:** ${user.hasGrokCodeAccess ? "yes" : "no"}`);
    }
  }

  if (creditsR.status === "fulfilled") {
    const cfg = creditsR.value?.config || creditsR.value || {};
    const period = cfg.currentPeriod || {};
    lines.push("");
    lines.push("### Credit period");
    lines.push(
      `- **Window:** ${period.type || "—"} · ${fmtWhen(period.start || cfg.billingPeriodStart)} → ${fmtWhen(period.end || cfg.billingPeriodEnd)}`
    );
    lines.push(`- **Credit usage:** ${pct(cfg.creditUsagePercent)}`);
    if (cfg.productUsage?.length) {
      lines.push("- **By product:**");
      for (const p of cfg.productUsage) {
        const name = p.product || p.name || "product";
        const u = p.usagePercent;
        lines.push(
          u == null ? `  - ${name}` : `  - ${name}: ${pct(u)}`
        );
      }
    }
    const onDemandCap = unwrapVal(cfg.onDemandCap);
    const onDemandUsed = unwrapVal(cfg.onDemandUsed);
    const prepaid = unwrapVal(cfg.prepaidBalance);
    if (onDemandCap != null || onDemandUsed != null) {
      lines.push(
        `- **On-demand:** ${centsToUsd(onDemandUsed) ?? onDemandUsed ?? 0} used / cap ${centsToUsd(onDemandCap) ?? onDemandCap ?? 0}`
      );
    }
    if (prepaid != null) {
      lines.push(`- **Prepaid balance:** ${centsToUsd(prepaid) ?? prepaid}`);
    }
  } else {
    lines.push("");
    lines.push(`_Credit period unavailable: ${creditsR.reason?.message || creditsR.reason}_`);
  }

  if (monthlyR.status === "fulfilled") {
    const cfg = monthlyR.value?.config || monthlyR.value || {};
    const limit = unwrapVal(cfg.monthlyLimit);
    const used = unwrapVal(cfg.used);
    lines.push("");
    lines.push("### Monthly allotment");
    lines.push(
      `- **Used:** ${centsToUsd(used) ?? used ?? "—"} / **limit** ${centsToUsd(limit) ?? limit ?? "—"}`
    );
    if (limit && used != null && Number(limit) > 0) {
      lines.push(`- **Of monthly limit:** ${pct((Number(used) / Number(limit)) * 100)}`);
    }
    lines.push(
      `- **Period:** ${fmtWhen(cfg.billingPeriodStart)} → ${fmtWhen(cfg.billingPeriodEnd)}`
    );
  }

  lines.push("");
  lines.push("### Manage");
  lines.push("- Billing: https://grok.com/?_s=billing");
  lines.push("- Usage: https://grok.com/?_s=usage");
  lines.push("");
  lines.push(
    "_Pulled live from your Mac’s Grok login — not via the agent tool loop._"
  );
  return lines.join("\n");
}

/** True for /usage, /cost, or plain “what’s my usage” style asks. */
function isUsageIntent(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const low = t.toLowerCase();
  if (low === "/usage" || low === "/cost") return true;
  if (low.startsWith("/usage ") || low.startsWith("/cost ")) return true;
  // plain language — keep tight so we don't steal real coding questions
  if (
    /^(what'?s|what is|show|check|get|how much)\b.*\b(usage|cost|credits?|billing)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^(my\s+)?(usage|cost|credits?|billing)\s*\??$/i.test(t)) return true;
  return false;
}

/**
 * Trivial cwd/folder questions — answer instantly without the agent tool loop.
 * (Agent often hangs after "I'll check pwd..." with a stuck shell tool.)
 */
function isCwdIntent(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 120) return false;
  if (
    /^(what|which)\s+(folder|directory|dir|path|cwd)\b/i.test(t) ||
    /^(what|which)\s+folder\s+are\s+we\s+in\b/i.test(t) ||
    /^where\s+am\s+i\b/i.test(t) ||
    /^where\s+are\s+we\b/i.test(t) ||
    /^(pwd|cwd)\s*\??$/i.test(t) ||
    /^what('s| is)\s+(the\s+)?(current\s+)?(working\s+)?(folder|directory|dir|path|cwd)\b/i.test(
      t
    ) ||
    /^what\s+folder\s+(are|is)\s+(we|i|you)\s+in\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function formatCwdReport() {
  return [
    `**Folder (agent cwd):** \`${CWD}\``,
    "",
    "This is the phone bridge workspace (`PHONE_CHAT_CWD` / default parent of the app). The agent runs tools from here unless a command uses another absolute path.",
  ].join("\n");
}

// ─── ACP client (long-lived grok agent stdio) ───────────────────────────────

class GrokAcp {
  constructor(cwd) {
    this.cwd = cwd;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.sessionId = null;
    /** True when live session came from session/load (reconnect). */
    this.sessionResumed = false;
    this.loadSessionSupported = false;
    /** Durable ACP session id to reload after process death. */
    this.preferredSessionId = null;
    this.listeners = new Set();
    this.ready = null;
    /** Handles agent→client terminal/* requests (required when terminal:true). */
    this.terminals = new TerminalManager();
    const extraRoots = (process.env.PHONE_CHAT_FS_ROOTS || "")
      .split(/[:;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowedRoots = defaultAllowedRoots(cwd, {
      // Full home is powerful (agent can read/write almost anything) — opt-in.
      allowHome:
        process.env.PHONE_CHAT_ALLOW_HOME === "1" ||
        process.env.PHONE_CHAT_ALLOW_HOME === "true",
      extraRoots,
    });
    /** Shared demux + agent-request answers (same code path unit tests drive). */
    this.lineHandler = new AcpLineHandler({
      terminals: this.terminals,
      allowedRoots: this.allowedRoots,
      writeMessage: (obj) => this._writeMessage(obj),
      onSessionUpdate: (update) => this.emit(update),
      onActivity: () => this.emit({ sessionUpdate: "client_activity" }),
      onWarn: (msg) => console.warn(`[acp] ${msg}`),
    });
  }

  /** @returns {Map<string|number, {resolve: Function, reject: Function}>} */
  get pending() {
    return this.lineHandler.pending;
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(update) {
    for (const fn of this.listeners) {
      try {
        fn(update);
      } catch {
        /* ignore */
      }
    }
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  /** Kill agent process and reject in-flight ACP requests. */
  async stop() {
    this.lineHandler.clearPending("agent reset");
    try {
      await this.terminals.releaseAll();
    } catch {
      /* ignore */
    }
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        /* ignore */
      }
      this.rl = null;
    }
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.sessionId = null;
    this.sessionResumed = false;
    this.nextId = 1;
    if (proc && !proc.killed) {
      // SIGTERM → SIGKILL; process-group kill when detached (Unix)
      await killProcessTree(proc, { graceMs: 400 });
    }
  }

  /**
   * Stop + start. By default keeps preferredSessionId so the next start can
   * session/load the same conversation (reconnect without losing agent memory).
   * @param {{ fresh?: boolean }} [opts] fresh=true drops preferred session (phone Reset)
   */
  async reset(opts = {}) {
    if (opts.fresh) {
      this.preferredSessionId = null;
    }
    await this.stop();
    await new Promise((r) => setTimeout(r, 400));
    return this.start();
  }

  async _start() {
    this.sessionResumed = false;
    this.proc = spawn(
      GROK_BIN,
      [
        "agent",
        "--always-approve",
        "--effort",
        AGENT_REASONING_EFFORT,
        "stdio",
      ],
      {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        // New process group on Unix so stop() can kill shell grandchildren
        detached: process.platform !== "win32",
      }
    );
    this.proc.stderr?.on("data", (c) => {
      const s = c.toString("utf8");
      if (process.env.PHONE_CHAT_DEBUG) process.stderr.write(`[grok] ${s}`);
    });
    this.proc.on("exit", (code) => {
      console.error(`[agent] exited code=${code}`);
      this.ready = null;
      // Keep preferredSessionId so a later start() can session/load
      this.sessionId = null;
      this.sessionResumed = false;
      this.lineHandler.clearPending("agent process exited");
      void this.terminals.releaseAll().catch(() => {});
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this._onLine(line));

    const init = await this.request("initialize", {
      protocolVersion: "1",
      clientInfo: { name: "grok-cli-phone-remote-control", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.loadSessionSupported = !!(
      init?.agentCapabilities?.loadSession ||
      init?.agentCapabilities?.load_session
    );

    // Prefer reloading the durable ACP session (same conversation as remote apps)
    const wantId = this.preferredSessionId;
    if (wantId && this.loadSessionSupported) {
      try {
        const loaded = await this.request("session/load", {
          sessionId: wantId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId =
          loaded.sessionId || loaded.session_id || wantId;
        this.sessionResumed = true;
        this.preferredSessionId = this.sessionId;
        console.log(
          `[agent] session/load ok ${this.sessionId} cwd=${this.cwd}`
        );
        return;
      } catch (e) {
        console.warn(
          `[agent] session/load failed (${e.message}); falling back to session/new`
        );
      }
    }

    const sess = await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
      _meta: { yoloMode: true },
    });
    this.sessionId = sess.sessionId || sess.session_id;
    this.sessionResumed = false;
    if (!this.sessionId) {
      throw new Error("session/new did not return sessionId: " + JSON.stringify(sess));
    }
    this.preferredSessionId = this.sessionId;
    console.log(`[agent] session/new ${this.sessionId} cwd=${this.cwd}`);
  }

  /** Demux entry — delegates to AcpLineHandler (shared with unit tests). */
  _onLine(line) {
    this.lineHandler.onLine(line);
  }

  _writeMessage(obj) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      console.warn("[acp] write failed", e.message);
    }
  }

  request(method, params, timeoutMs = 15 * 60 * 1000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.lineHandler.trackPending(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin.write(msg + "\n");
      // safety timeout (prompt jobs use a shorter outer race too)
      setTimeout(() => {
        if (this.lineHandler.hasPending(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** Best-effort cancel of the in-flight prompt (if supported). */
  async cancel() {
    if (!this.sessionId || !this.proc) return;
    try {
      // fire-and-forget — some agents ignore unknown methods
      const id = this.nextId++;
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/cancel",
          params: { sessionId: this.sessionId },
        }) + "\n"
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {{ text: string, imagePaths?: string[] }} input
   * @param {(ev: object) => void} onEvent
   */
  async prompt(input, onEvent) {
    await this.start();
    const parts = [];
    if (input.text?.trim()) {
      parts.push({ type: "text", text: input.text.trim() });
    }
    // Prefer filesystem paths — Grok Build can read images via tools reliably.
    for (const p of input.imagePaths || []) {
      parts.push({
        type: "text",
        text: `\n[Phone attachment saved at: ${p}]\nPlease open/view this image if relevant to the request.`,
      });
      // Also try ACP image block if supported (ignored if not)
      try {
        const buf = await readFile(p);
        const mime =
          extname(p).toLowerCase() === ".png"
            ? "image/png"
            : extname(p).toLowerCase() === ".webp"
              ? "image/webp"
              : "image/jpeg";
        parts.push({
          type: "image",
          mimeType: mime,
          data: buf.toString("base64"),
        });
      } catch {
        /* path text is enough */
      }
    }
    if (!parts.length) {
      throw new Error("empty message");
    }

    const unsub = this.onUpdate((update) => {
      onEvent?.({ type: "update", update });
    });

    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: parts,
      });
      onEvent?.({ type: "done", result });
      return result;
    } finally {
      unsub();
    }
  }
}

const MAX_AGENTS = Number(process.env.PHONE_CHAT_MAX_AGENTS || 6);
const registry = createAgentRegistry({
  createAcp: (cwd) => new GrokAcp(cwd),
  defaultCwd: CWD,
  maxAgents: Number.isFinite(MAX_AGENTS) && MAX_AGENTS >= 1 ? MAX_AGENTS : 6,
});
/** Main ACP instance (back-compat). Extra agents live in `registry`. */
const agent = registry.main.acp;
/** @type {import('./lib/conversation.mjs').ConversationState} */
let conversation = emptyConversation();

async function persistConversation() {
  try {
    if (agent.sessionId) conversation.acpSessionId = agent.sessionId;
    await saveConversation(CONVERSATION_PATH, conversation);
  } catch (e) {
    console.warn("[conversation] save failed", e.message);
  }
}

async function persistAgentRoster() {
  try {
    await saveAgentRoster(AGENTS_PATH, registry.snapshotExtras());
  } catch (e) {
    console.warn("[agents] save roster failed", e.message);
  }
}

async function rememberJobInConversation(job) {
  if (!job?.id) return;
  // Extra agents must not land in the main host transcript (phone main chat).
  if (!jobBelongsToMainConversation(job)) {
    if (isTerminalJobStatus(job.status)) await persistAgentRoster();
    return;
  }
  upsertJobInConversation(conversation, job);
  // Durable transcript is shared; ACP session resume only applies to main.
  // Extra concurrent agents keep their own process-local sessionIds.
  const agentId = job.agentId || "main";
  if (agentId === "main" || agentId === "default") {
    if (job.sessionId) {
      conversation.acpSessionId = job.sessionId;
      agent.preferredSessionId = job.sessionId;
    } else if (agent.sessionId) {
      conversation.acpSessionId = agent.sessionId;
      agent.preferredSessionId = agent.sessionId;
    }
  }
  await persistConversation();
}

// warm start: durable conversation + extra-agent roster + recover jobs + resume ACP
(async () => {
  try {
    conversation = await loadConversation(CONVERSATION_PATH);
    conversation = await rebuildConversationFromJobs(JOBS_DIR, conversation);
    if (conversation.acpSessionId) {
      agent.preferredSessionId = conversation.acpSessionId;
    }
    await saveConversation(CONVERSATION_PATH, conversation);
    console.log(
      `[conversation] id=${conversation.conversationId} turns=${conversation.turns.length} acp=${conversation.acpSessionId || "(none)"}`
    );
  } catch (e) {
    console.warn("[conversation] bootstrap failed", e.message);
  }
  try {
    const saved = await loadAgentRoster(AGENTS_PATH);
    const restored = registry.restore(
      saved.map((rec) => ({
        ...rec,
        cwd: rec.cwd && existsSync(rec.cwd) ? rec.cwd : CWD,
      }))
    );
    if (restored.length) {
      console.log(
        `[agents] restored ${restored.length}: ${restored.map((a) => a.label).join(", ")}`
      );
    }
  } catch (e) {
    console.warn("[agents] restore failed", e.message);
  }
  try {
    await recoverJobsOnStartup();
  } catch (e) {
    console.error("[jobs] recovery failed:", e.message);
  }
  try {
    await agent.start();
    if (agent.sessionId) {
      conversation.acpSessionId = agent.sessionId;
      await persistConversation();
    }
  } catch (e) {
    console.error("[agent] start failed:", e.message);
  }
  for (const pub of registry.list()) {
    if (pub.isMain) continue;
    const slot = registry.get(pub.id);
    if (!slot?.acp) continue;
    void slot.acp
      .start()
      .then(() => persistAgentRoster())
      .catch((e) =>
        console.warn("[agents] resume start failed", pub.id, e.message)
      );
  }
})();
// every 15s: unstick jobs that claim running but aren't being processed
setInterval(() => {
  void sweepOrphanJobs();
}, 15_000);

// ─── HTTP ───────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  // Safari requires JS MIME for ES modules — octet-stream breaks import and kills the whole app.js
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function secretsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function authOk(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ") && secretsEqual(h.slice(7), SECRET)) return true;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (secretsEqual(url.searchParams.get("token") || "", SECRET)) return true;
  return false;
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      const err = new Error(`request body too large (max ${maxBytes} bytes)`);
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ─── Durable job queue (work on Mac; phone can lock / disconnect) ───────────
/** @type {Map<string, object>} */
const jobs = new Map();
/**
 * Per-agent queues live on registry slots (jobQueue / currentJobId / queueRunning).
 * Helpers below keep cancel/status/sweep multi-agent aware.
 */
function slotFor(agentId) {
  return registry.get(agentId) || registry.main;
}

function allSlots() {
  return registry.list().map((a) => registry.get(a.id)).filter(Boolean);
}

function isCurrentJobAnywhere(jobId) {
  return allSlots().some((s) => s.currentJobId === jobId);
}

function anyQueueRunning() {
  return allSlots().some((s) => s.queueRunning);
}

function totalQueueLength() {
  return allSlots().reduce((n, s) => n + s.jobQueue.length, 0);
}

/** Main-agent aliases for back-compat within this file where still single-path. */
const jobQueue = registry.main.jobQueue;
function getMainQueueRunning() {
  return registry.main.queueRunning;
}
function getMainCurrentJobId() {
  return registry.main.currentJobId;
}

function jobPath(id) {
  return join(JOBS_DIR, `${id}.json`);
}

/**
 * After a Mac bridge restart, jobs left as "running" would poll forever on the
 * phone (first reply only). Mark them interrupted; re-queue anything still queued.
 */
async function recoverJobsOnStartup() {
  let interrupted = 0;
  let requeued = 0;
  let names = [];
  try {
    names = await readdir(JOBS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let job;
    try {
      job = JSON.parse(await readFile(join(JOBS_DIR, name), "utf8"));
    } catch {
      continue;
    }
    if (!job?.id) continue;
    jobs.set(job.id, job);
    if (job.status === "running") {
      job.status = "error";
      job.error = "interrupted by server restart";
      const note =
        "\n\n_(Interrupted — Mac bridge restarted mid-reply. Send the message again to continue.)_";
      if (!(job.reply || "").includes("Interrupted — Mac bridge")) {
        job.reply = (job.reply || "").trimEnd() + note;
      }
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await persistJob(job);
      interrupted++;
    } else if (job.status === "queued") {
      const want = String(job.agentId || "main").trim() || "main";
      const slot = registry.get(want) || registry.main;
      if (slot.id !== want) {
        job.agentId = slot.id;
        job.updatedAt = new Date().toISOString();
        await persistJob(job);
      }
      if (!slot.jobQueue.includes(job.id)) {
        slot.jobQueue.push(job.id);
        requeued++;
      }
    }
  }
  if (interrupted || requeued) {
    console.log(
      `[jobs] startup recovery: interrupted=${interrupted} requeued=${requeued}`
    );
  }
  if (requeued) {
    for (const pub of registry.list()) {
      if (pub.queueLength) void processQueue(pub.id);
    }
  }
}

/**
 * Catch jobs left "running" only after a true crash (not mid-turn).
 * Must NEVER kill the job that processQueue is actively running — that was
 * aborting real work and leaving the phone with only the first line.
 */
async function sweepOrphanJobs() {
  const now = Date.now();
  const ORPHAN_AGE_MS = 15 * 60 * 1000; // 15m of no updates AND not current

  for (const [id, job] of jobs) {
    if (job.status !== "running") continue;
    // Never touch the active job, even if it's been silent for a while —
    // runAgentTurn's idle watchdog owns that case.
    if (isCurrentJobAnywhere(id)) continue;
    const slot = slotFor(job.agentId || "main");
    if (slot.queueRunning && slot.jobQueue.includes(id)) continue;

    const updated = Date.parse(job.updatedAt || job.startedAt || 0) || 0;
    if (now - updated < ORPHAN_AGE_MS) continue;

    job.status = "error";
    job.error = "orphaned (not processing)";
    const note =
      "\n\n_(Stopped — job was stuck after a disconnect. Send again if you still need an answer.)_";
    if (!(job.reply || "").includes("Stopped — job was stuck")) {
      job.reply = (job.reply || "").trimEnd() + note;
    }
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await persistJob(job);
    console.warn(
      `[jobs] swept orphan running job ${id} (silent ${Math.round((now - updated) / 1000)}s, agent=${job.agentId || "main"})`
    );
  }

  // Disk-only: only after long silence, never if it matches a live current job
  try {
    const names = await readdir(JOBS_DIR);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.replace(/\.json$/, "");
      if (isCurrentJobAnywhere(id)) continue;
      if (jobs.has(id)) continue;
      try {
        let job;
        const raw = await readFile(join(JOBS_DIR, name), "utf8");
        try {
          job = JSON.parse(raw);
        } catch {
          job = JSON.parse(
            raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
          );
        }
        if (job.status !== "running") {
          jobs.set(job.id, job);
          continue;
        }
        const updated = Date.parse(job.updatedAt || job.startedAt || 0) || 0;
        if (now - updated < ORPHAN_AGE_MS) {
          jobs.set(job.id, job);
          continue;
        }
        job.status = "error";
        job.error = "orphaned (not processing)";
        job.reply =
          (job.reply || "").trimEnd() +
          "\n\n_(Stopped — job was stuck after a disconnect. Send again if you still need an answer.)_";
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        jobs.set(job.id, job);
        await persistJob(job);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function publicJob(job) {
  const replyImages = Array.isArray(job.replyImages) ? job.replyImages : [];
  const agentId = job.agentId || "main";
  const slot = slotFor(agentId);
  const agentPub = registry.list().find((a) => a.id === agentId);
  return {
    id: job.id,
    status: job.status,
    text: job.text,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    reply: job.reply || "",
    /** Latest reasoning/thought stream from the agent (for inline UI). */
    thought: job.thought || "",
    tools: job.tools || [],
    error: job.error || null,
    agentId,
    agentLabel: job.loopName
      ? job.loopName
      : agentPub?.label || (agentId === "main" ? "Main" : agentId.slice(0, 8)),
    loopId: job.loopId || null,
    source: job.source || null,
    queuePosition:
      job.status === "queued"
        ? Math.max(0, slot.jobQueue.indexOf(job.id) + 1)
        : 0,
    sessionId: job.sessionId || null,
    /** Generated images (Imagine etc.) — client loads via /api/jobs/:id/media/:i */
    images: replyImages.map((p, i) => ({
      index: i,
      name: basename(String(p)),
      path: `/api/jobs/${job.id}/media/${i}`,
    })),
  };
}

// ─── Reply image capture (image_gen / image_edit / …) ───────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|tiff?)$/i;
const IMAGE_TOOL_RAW_TYPES = new Set([
  "ImageGen",
  "ImageEdit",
  "ImageToVideo",
  "ReferenceToVideo",
]);

function sessionImagesDir(sessionId) {
  if (!sessionId) return null;
  // Grok stores sessions as ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/
  return join(
    homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(CWD),
    sessionId,
    "images"
  );
}

function addReplyImage(job, absPath) {
  if (!absPath || typeof absPath !== "string") return;
  const p = absPath.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!p.startsWith("/") || !IMAGE_EXT_RE.test(p)) return;
  if (!existsSync(p)) return;
  if (!Array.isArray(job.replyImages)) job.replyImages = [];
  if (!job.replyImages.includes(p)) {
    job.replyImages.push(p);
  }
}

function collectPathsFromText(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  // Absolute paths to image files
  const re =
    /(\/(?:Users|Volumes|home|tmp|var)[^\s`'"<>\]\)]+\.(?:png|jpe?g|webp|gif|tiff?))/gi;
  for (const m of text.matchAll(re)) out.push(m[1]);
  // JSON blobs from tool content: {"path":"..."}
  try {
    const j = JSON.parse(text);
    if (j && typeof j.path === "string") out.push(j.path);
    if (Array.isArray(j?.paths)) {
      for (const p of j.paths) if (typeof p === "string") out.push(p);
    }
  } catch {
    /* not json */
  }
  return out;
}

function collectImagesFromUpdate(job, u) {
  if (!u || typeof u !== "object") return;

  const raw = u.rawOutput;
  if (raw && typeof raw === "object") {
    if (IMAGE_TOOL_RAW_TYPES.has(raw.type) && raw.path) {
      addReplyImage(job, raw.path);
    }
    if (typeof raw.path === "string" && IMAGE_EXT_RE.test(raw.path)) {
      addReplyImage(job, raw.path);
    }
    // some variants nest under Content
    if (raw.Content?.path) addReplyImage(job, raw.Content.path);
  }

  const metaTool = u._meta?.["x.ai/tool"] || {};
  const toolName = metaTool.name || u.title || "";
  const isImageTool =
    /image_gen|image_edit|image_to_video|reference_to_video/i.test(
      String(toolName)
    ) || metaTool.kind === "image_gen";

  const content = u.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const inner = block?.content || block;
      if (!inner || typeof inner !== "object") continue;
      if (inner.type === "image") {
        // inline base64 — persist under phone-inbox for serving
        if (inner.data && typeof inner.data === "string") {
          try {
            const mime = inner.mimeType || "image/png";
            const ext = mime.includes("jpeg") || mime.includes("jpg")
              ? ".jpg"
              : mime.includes("webp")
                ? ".webp"
                : ".png";
            const dest = join(INBOX, `gen-${randomUUID()}${ext}`);
            writeFileSync(dest, Buffer.from(inner.data, "base64"));
            addReplyImage(job, dest);
          } catch (e) {
            console.warn("[images] save inline image failed", e.message);
          }
        }
        if (inner.uri || inner.url) {
          const uri = String(inner.uri || inner.url);
          if (uri.startsWith("/") && IMAGE_EXT_RE.test(uri)) {
            addReplyImage(job, uri);
          }
        }
      }
      if (inner.type === "text" && typeof inner.text === "string") {
        for (const p of collectPathsFromText(inner.text)) {
          addReplyImage(job, p);
        }
      }
    }
  }

  // locations sometimes list generated files
  if (Array.isArray(u.locations)) {
    for (const loc of u.locations) {
      if (loc?.path && IMAGE_EXT_RE.test(loc.path)) addReplyImage(job, loc.path);
    }
  }

  // rawInput for image tools may only have prompts; skip unless completed with path
  if (isImageTool && u.status === "completed") {
    for (const p of collectPathsFromText(JSON.stringify(u).slice(0, 8000))) {
      addReplyImage(job, p);
    }
  }
}

async function scanNewSessionImages(job, sessionId, sinceMs) {
  const dir = sessionImagesDir(sessionId);
  if (!dir || !existsSync(dir)) return;
  try {
    const names = await readdir(dir);
    for (const name of names) {
      if (!IMAGE_EXT_RE.test(name)) continue;
      const full = join(dir, name);
      try {
        const st = await stat(full);
        // include files created/modified during this job (small skew)
        if (st.mtimeMs >= sinceMs - 2000) {
          addReplyImage(job, full);
        }
      } catch {
        /* skip */
      }
    }
  } catch (e) {
    console.warn("[images] session scan failed", e.message);
  }
}

/** Append markdown image embeds so text clients still see them. */
function appendImageMarkdown(job) {
  const imgs = job.replyImages || [];
  if (!imgs.length) return;
  const already = job.reply || "";
  const lines = [];
  for (let i = 0; i < imgs.length; i++) {
    const name = basename(imgs[i]);
    // relative API path — client may also render via job.images
    const md = `![${name}](/api/jobs/${job.id}/media/${i})`;
    if (!already.includes(`/media/${i}`) && !already.includes(name)) {
      lines.push(md);
    }
  }
  if (lines.length) {
    job.reply = (already ? already.replace(/\s*$/, "\n\n") : "") + lines.join("\n\n");
  }
}

function isAllowedMediaPath(absPath) {
  if (!absPath || typeof absPath !== "string") return false;
  const allowedRoots = [
    resolve(join(homedir(), ".grok")),
    resolve(INBOX),
    resolve(tmpdir()),
    resolve(CWD),
  ];
  return isPathAllowed(absPath, allowedRoots);
}

/** Serialize disk writes per job so concurrent stream updates never corrupt JSON. */
const persistChains = new Map();
/** Live SSE subscribers: jobId → Set<ServerResponse> */
const jobSubscribers = new Map();

function notifyJobSubscribers(job) {
  if (!job?.id) return;
  const subs = jobSubscribers.get(job.id);
  if (!subs || !subs.size) return;
  let payload;
  try {
    payload = JSON.stringify(publicJob(job));
  } catch (e) {
    console.warn("[sse] serialize failed", e.message);
    return;
  }
  const chunk = `event: job\ndata: ${payload}\n\n`;
  const terminal =
    job.status === "done" ||
    job.status === "error" ||
    job.status === "cancelled";
  for (const res of [...subs]) {
    try {
      res.write(chunk);
      if (terminal) {
        res.write(`event: end\ndata: ${payload}\n\n`);
        res.end();
        subs.delete(res);
      }
    } catch {
      subs.delete(res);
    }
  }
  if (!subs.size) jobSubscribers.delete(job.id);
}

function subscribeJob(jobId, res) {
  if (!jobSubscribers.has(jobId)) jobSubscribers.set(jobId, new Set());
  jobSubscribers.get(jobId).add(res);
  res.on("close", () => {
    const s = jobSubscribers.get(jobId);
    if (s) {
      s.delete(res);
      if (!s.size) jobSubscribers.delete(jobId);
    }
  });
}

async function persistJob(job) {
  if (!job?.id) return;
  jobs.set(job.id, job);
  const id = job.id;
  const prev = persistChains.get(id) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      // snapshot fields for a consistent write
      const live = jobs.get(id) || job;
      const snapshot = JSON.stringify(live);
      const dest = jobPath(id);
      const tmp = dest + `.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, dest);
      // Push live update to any phone SSE listeners
      notifyJobSubscribers(live);
      // Durable conversation transcript for reconnect (host-backed history)
      try {
        await rememberJobInConversation(live);
      } catch (e) {
        console.warn("[conversation] upsert failed", e.message);
      }
    })
    .catch((e) => {
      console.warn("[jobs] persist failed", id, e.message);
    })
    .finally(() => {
      if (persistChains.get(id) === next) persistChains.delete(id);
    });
  persistChains.set(id, next);
  return next;
}

async function loadJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const raw = await readFile(jobPath(id), "utf8");
    // tolerate rare corruption from older non-atomic writes
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      const dec = JSON;
      // take first complete JSON value
      const parser = JSON.parse;
      try {
        const start = raw.indexOf("{");
        let depth = 0;
        let end = -1;
        for (let i = start; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
        if (start >= 0 && end > start) job = JSON.parse(raw.slice(start, end));
        else throw new Error("unrecoverable");
      } catch {
        return null;
      }
    }
    jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

/** True if the reply looks like only a pre-tool "I'll look into it" line. */
function looksLikePartialAckOnly(reply, tools) {
  const t = String(reply || "").trim();
  if (!t) return true;
  if ((tools || []).length === 0) return false;
  // short opener, no real sections/lists
  if (t.length > 600) return false;
  if (/\n#{1,3}\s|\n[-*]\s|\n\d+\.\s|```/.test(t)) return false;
  // Common pre-tool acknowledgements (agent often ends the turn here without the answer)
  return /^(i('ll| will)|let me|looking|i'm going to|i am going to|checking|i'll check|i'll look|running|executing|i am running|i'm running|on it|one moment|working on)\b/i.test(
    t
  );
}

/**
 * Headless one-shot fallback when the long-lived agent hangs mid-turn.
 * Always returns a finished string (or throws).
 */
function runHeadlessPrompt(promptText, cwd, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const args = [
      "--always-approve",
      "--effort",
      AGENT_REASONING_EFFORT,
      "--cwd",
      cwd,
      "-p",
      promptText,
      "--output-format",
      "plain",
    ];
    const proc = spawn(GROK_BIN, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`headless timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stdout?.on("data", (c) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", (c) => {
      err += c.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (text) resolve(text);
      else
        reject(
          new Error(
            `headless exit ${code}${err ? `: ${err.slice(0, 200)}` : ""}`
          )
        );
    });
  });
}

function isTransientAgentError(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("agent process exited") ||
    m.includes("agent reset") ||
    m.includes("acp timeout") ||
    m.includes("econnreset") ||
    m.includes("write after end") ||
    m.includes("stdin") ||
    m.includes("not ready")
  );
}

/**
 * One agent turn with idle + max timeouts. Mutates job.reply/tools/images.
 * @returns {{ ok: boolean, timedOut: boolean, idleTimedOut: boolean, error?: string }}
 */
async function runAgentTurn(job, promptText, opts = {}) {
  const attempt = opts.attempt || 1;
  /** @type {GrokAcp} */
  const acp = opts.acp || agent;
  let timedOut = false;
  let idleTimedOut = false;
  const turnStartMs = Date.now();
  let lastProgressMs = Date.now();

  const wantsImage =
    /\b(image_gen|image_edit|imagine|\/imagine|render|photo|picture|illustration)\b/i.test(
      promptText
    ) ||
    /\b(generate|create|draw|make)\b.+\b(image|photo|picture|render)\b/i.test(
      promptText
    );
  const idleMs = wantsImage
    ? Math.max(JOB_IDLE_TIMEOUT_MS, 8 * 60 * 1000)
    : JOB_IDLE_TIMEOUT_MS;
  const maxMs = wantsImage
    ? Math.max(JOB_MAX_TIMEOUT_MS, 30 * 60 * 1000)
    : JOB_MAX_TIMEOUT_MS;

  const killForTimeout = (reason) => {
    if (timedOut) return;
    timedOut = true;
    idleTimedOut = reason === "idle";
    console.warn(
      `[jobs] ${job.id} timeout reason=${reason} attempt=${attempt} silent=${Math.round((Date.now() - lastProgressMs) / 1000)}s`
    );
    void acp.cancel();
    void acp.reset().catch((e) =>
      console.warn("[jobs] reset after timeout", e.message)
    );
  };

  const markProgress = () => {
    lastProgressMs = Date.now();
    job.updatedAt = new Date().toISOString();
  };

  // Interval watchdog is more reliable than a single setTimeout when the
  // event loop is busy or the agent hangs at 0% CPU with no events.
  const watch = setInterval(() => {
    const now = Date.now();
    if (now - turnStartMs >= maxMs) {
      killForTimeout("max");
    } else if (now - lastProgressMs >= idleMs) {
      // Long-running tools (EAS, next build, emulator) go quiet on purpose.
      // Killing them is what made phone sessions look like they "ended early."
      if (hasInFlightWork(job, acp.terminals?.terminals)) {
        return;
      }
      killForTimeout("idle");
    }
  }, 2000);

  // Ensure agent is up before prompting
  try {
    await acp.start();
  } catch (e) {
    clearInterval(watch);
    return {
      ok: false,
      timedOut: false,
      idleTimedOut: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    await acp.prompt(
      { text: promptText, imagePaths: job.imagePaths || [] },
      (ev) => {
        // Cancel / Stop & show sealed the job — ignore further stream chunks
        if (isJobSealed(job)) return;
        job.updatedAt = new Date().toISOString();
        if (ev.type === "update") {
          // Production progressive path — same function unit tests drive
          const applied = applySessionUpdate(job, ev.update || {});
          if (applied.sealed) return;
          if (applied.progressed) markProgress();
          if (applied.imageContent) {
            collectImagesFromUpdate(job, {
              content: [{ type: "content", content: applied.imageContent }],
            });
          }
          for (const p of applied.paths || []) addReplyImage(job, p);
          if (applied.toolUpdate) {
            collectImagesFromUpdate(job, applied.toolUpdate);
          }
        } else if (ev.type === "done") {
          markProgress();
          applyPromptDone(job, ev.result);
        }
        // persist often so phone always has latest partial/final text + SSE push
        if (!isJobSealed(job)) void persistJob(job);
      }
    );

    await scanNewSessionImages(
      job,
      acp.sessionId || job.sessionId,
      turnStartMs
    );
    appendImageMarkdown(job);

    if (timedOut) {
      return {
        ok: false,
        timedOut: true,
        idleTimedOut,
        error: idleTimedOut
          ? `idle timeout ${Math.round(idleMs / 1000)}s`
          : `max timeout ${Math.round((Date.now() - turnStartMs) / 1000)}s`,
      };
    }
    return { ok: true, timedOut: false, idleTimedOut: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await scanNewSessionImages(
      job,
      acp.sessionId || job.sessionId,
      turnStartMs
    ).catch(() => {});
    appendImageMarkdown(job);
    return {
      ok: false,
      timedOut,
      idleTimedOut,
      error: timedOut
        ? idleTimedOut
          ? `idle timeout ${Math.round(idleMs / 1000)}s`
          : `max timeout ${Math.round((Date.now() - turnStartMs) / 1000)}s`
        : msg,
    };
  } finally {
    clearInterval(watch);
  }
}

/**
 * Recent finished jobs (memory + disk) for short follow-up context.
 * @param {string} excludeId
 * @param {number} limit
 */
async function loadRecentFinishedJobs(excludeId, limit = 4, agentId = "main") {
  const out = [];
  const seen = new Set();
  const consider = (j) => {
    if (!j?.id || j.id === excludeId || seen.has(j.id)) return;
    if (!isTerminalJobStatus(j.status)) return;
    if (isMainAgentId(agentId)) {
      if (!jobBelongsToMainConversation(j)) return;
    } else if (String(j.agentId || "main") !== String(agentId)) {
      return;
    }
    seen.add(j.id);
    out.push(j);
  };
  // In-memory first (newest-ish by updatedAt)
  const mem = [...jobs.values()].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(
      String(a.updatedAt || a.createdAt || "")
    )
  );
  for (const j of mem) {
    consider(j);
    if (out.length >= limit) return out;
  }
  try {
    const files = await readdir(JOBS_DIR);
    const jsons = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(JOBS_DIR, f));
    const stats = await Promise.all(
      jsons.map(async (p) => {
        try {
          const s = await stat(p);
          return { p, m: s.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    stats
      .filter(Boolean)
      .sort((a, b) => b.m - a.m)
      .slice(0, 12)
      .forEach((x) => {});
    for (const row of stats.filter(Boolean).sort((a, b) => b.m - a.m).slice(0, 12)) {
      try {
        const raw = await readFile(row.p, "utf8");
        consider(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      if (out.length >= limit) break;
    }
  } catch {
    /* ignore */
  }
  return out.slice(0, limit);
}

/**
 * @param {object} job
 * @param {GrokAcp} [acpInst] agent process for this job's slot
 */
async function runJob(job, acpInst) {
  const acp = acpInst || slotFor(job.agentId || "main").acp || agent;
  if (isJobSealed(job)) return; // phone already Stop & show / cancel'd
  job.status = "running";
  job.startedAt = job.startedAt || new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  job.agentId = job.agentId || "main";
  if (!job.reply) job.reply = "";
  if (!job.thought) job.thought = "";
  if (!job.tools) job.tools = [];
  if (!job.replyImages) job.replyImages = [];
  job.attempts = job.attempts || 0;
  await persistJob(job);

  // Usage must NEVER hit the agent tool-loop (it freezes hunting for APIs).
  if (isUsageIntent(job.text)) {
    try {
      job.reply = await formatUsageReport();
      job.status = "done";
      job.error = null;
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.reply = `Failed to fetch usage: ${job.error}\n\nTry https://grok.com/?_s=billing`;
    }
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.sessionId = acp.sessionId;
    await persistJob(job);
    return;
  }

  // Cwd / "what folder are we in" — instant (agent often hangs on pwd shell)
  if (isCwdIntent(job.text)) {
    job.reply = formatCwdReport();
    job.status = "done";
    job.error = null;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.sessionId = acp.sessionId;
    await persistJob(job);
    return;
  }

  // Local slash handlers (instant, no agent)
  try {
    const local = await tryLocalSlashCommand(job.text);
    if (local != null) {
      job.reply = local;
      job.status = "done";
      job.error = null;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.sessionId = acp.sessionId;
      await persistJob(job);
      return;
    }
  } catch (e) {
    console.warn("[slash] local handler error", e.message);
  }

  let promptText = expandSlashForAgent(job.text);
  // Multi-turn continuity when ACP session is brand-new (not session/load):
  // inject durable transcript so reconnect / agent process death still has prior text.
  // Always inject for short follow-ups ("yes please") even if session was loaded —
  // load may not replay tool-side history the model needs for confirmations.
  const needTranscript =
    !job.loopId &&
    job.source !== "loop" &&
    (!acp.sessionResumed || isShortFollowUp(job.text));
  if (needTranscript) {
    try {
      const jobIsMain = jobBelongsToMainConversation(job);
      const fromConv = jobIsMain
        ? buildTranscriptPromptContext(conversation.turns, job.id, 10)
        : "";
      if (fromConv) {
        promptText = `${fromConv}\n\nUser's latest message: ${job.text.trim()}`;
        console.log(
          `[jobs] ${job.id} injected durable transcript (resumed=${!!acp.sessionResumed})`
        );
      } else if (isShortFollowUp(job.text) || !jobIsMain) {
        const recent = await loadRecentFinishedJobs(
          job.id,
          3,
          job.agentId || "main"
        );
        const ctx = buildRecentContextBlock(recent, job.id, 2);
        if (ctx) {
          promptText = `${ctx}\n\nUser's latest message: ${job.text.trim()}`;
          console.log(
            `[jobs] ${job.id} injected prior-job context for short follow-up`
          );
        }
      }
    } catch (e) {
      console.warn("[jobs] context inject failed", e.message);
    }
  }
  let lastResult = { ok: false, timedOut: false, idleTimedOut: false, error: "not started" };
  const maxAttempts = 1 + Math.max(0, JOB_AUTO_RETRIES);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isJobSealed(job)) return;
    job.attempts = attempt;
    job.status = "running";
    job.error = null;
    // Fresh reply buffer each attempt (keep prior as prefix if retrying partial)
    if (attempt > 1) {
      const prior = (job.reply || "").trim();
      job.reply = "";
      job.thought = "";
      job.tools = [];
      // keep replyImages from earlier attempts
      promptText =
        expandSlashForAgent(job.text) +
        (prior
          ? `\n\n[System: previous attempt was cut off after a partial reply. Continue and give the COMPLETE final answer now. Partial was:\n${prior.slice(0, 800)}]`
          : `\n\n[System: previous attempt failed (${lastResult.error || "agent error"}). Retry and give a complete answer.]`);
      // Ensure a healthy agent process
      try {
        await acp.reset();
      } catch (e) {
        console.warn("[jobs] agent reset before retry failed", e.message);
      }
      console.log(
        `[jobs] ${job.id} auto-retry attempt=${attempt}/${maxAttempts}`
      );
    }

    job.updatedAt = new Date().toISOString();
    await persistJob(job);

    lastResult = await runAgentTurn(job, promptText, { attempt, acp });

    // Phone tapped "Stop & show" / cancel while we were working
    if (isJobSealed(job)) return;

    if (lastResult.ok) {
      // Success — but if we only got a pre-tool ack and tools ran, treat as incomplete
      if (looksLikePartialAckOnly(job.reply, job.tools)) {
        console.warn(
          `[jobs] ${job.id} looks incomplete after attempt ${attempt}${
            attempt < maxAttempts ? ", retrying" : ", falling back"
          }`
        );
        lastResult = {
          ok: false,
          timedOut: false,
          idleTimedOut: false,
          error: "incomplete partial ack",
        };
        if (attempt < maxAttempts) continue;
        break; // exhaust agent attempts → headless fallback below
      }
      if (isJobSealed(job)) return;
      job.status = "done";
      job.error = null;
      if (!job.reply && !(job.replyImages || []).length) {
        // empty success — retry once if possible
        if (attempt < maxAttempts) {
          lastResult = {
            ok: false,
            timedOut: false,
            idleTimedOut: false,
            error: "empty reply",
          };
          continue;
        }
        job.reply = "(no text response)";
      } else if (!job.reply && (job.replyImages || []).length) {
        job.reply = `Generated ${(job.replyImages || []).length} image(s).`;
        appendImageMarkdown(job);
      }
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.sessionId = acp.sessionId;
      await persistJob(job);
      return;
    }

    // Failed turn — retry agent only for process death / empty / incomplete;
    // idle hangs go straight to headless (no agent retry loop).
    const canRetry =
      attempt < maxAttempts &&
      !lastResult.idleTimedOut &&
      (isTransientAgentError(lastResult.error) ||
        lastResult.error === "incomplete partial ack" ||
        lastResult.error === "empty reply");

    if (!canRetry) break;

    // brief pause before retry
    await new Promise((r) => setTimeout(r, 800));
  }

  if (isJobSealed(job)) return;

  // Agent path failed — headless one-shot so the phone ALWAYS gets a finished reply.
  // Kill any wedged long-lived ACP session first (unanswered terminal/* / stuck
  // prompt). agent.start() alone is a no-op when this.ready is still set.
  try {
    console.warn(
      `[jobs] ${job.id} falling back to headless -p after agent failure: ${lastResult.error}`
    );
    try {
      await acp.cancel();
    } catch {
      /* ignore */
    }
    try {
      await acp.stop();
    } catch (e) {
      console.warn("[jobs] agent stop before headless failed", e.message);
    }

    if (isJobSealed(job)) return;

    job.tools = job.tools || [];
    job.tools.push({
      name: "headless_fallback",
      status: "running",
      at: new Date().toISOString(),
    });
    job.updatedAt = new Date().toISOString();
    await persistJob(job);
    const partial = (job.reply || "").trim();
    // Prefer injected context for short follow-ups; always keep partial reply
    let fallbackBase = promptText;
    if (!isShortFollowUp(job.text)) {
      fallbackBase = expandSlashForAgent(job.text);
    }
    const fallbackPrompt = [
      fallbackBase,
      "",
      "IMPORTANT: Give a complete final answer. Do not only say you will look — actually answer.",
      partial
        ? `Context from a previous partial attempt (may be incomplete):\n${partial.slice(0, 1200)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const headlessReply = await runHeadlessPrompt(
      fallbackPrompt,
      CWD,
      Math.min(JOB_MAX_TIMEOUT_MS, 15 * 60 * 1000)
    );
    // Re-check after long await — user may have finalized mid-headless
    if (isJobSealed(job)) return;
    job.reply = headlessReply;
    job.status = "done";
    job.error = null;
    const last = job.tools[job.tools.length - 1];
    if (last?.name === "headless_fallback") last.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.sessionId = acp.sessionId;
    // Fresh long-lived agent for subsequent phone messages
    void acp.start().catch((e) =>
      console.warn("[jobs] agent restart after headless failed", e.message)
    );
    await persistJob(job);
    return;
  } catch (e) {
    if (isJobSealed(job)) return;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[jobs] ${job.id} headless fallback failed:`, msg);
    forceTerminalizeJob(job, {
      reason: `${lastResult.error || "failed"}; headless: ${msg}`,
      status: "error",
    });
    job.sessionId = acp.sessionId;
    // Still kill/restart so the next message does not reuse a wedged session
    try {
      await acp.stop();
    } catch {
      /* ignore */
    }
    void acp.start().catch(() => {});
    await persistJob(job);
  }
}

async function processQueue(agentId = "main") {
  const slot = slotFor(agentId);
  if (slot.queueRunning) return;
  slot.queueRunning = true;
  const acp = slot.acp;
  try {
    while (slot.jobQueue.length) {
      const id = slot.jobQueue.shift();
      const job = jobs.get(id) || (await loadJob(id));
      if (!job || job.status === "done" || job.status === "error") continue;
      // cancelled while waiting
      if (job.status === "cancelled") continue;
      job.agentId = job.agentId || slot.id;
      slot.currentJobId = id;
      registry.touch(slot.id);
      try {
        // Always warm agent before a turn so replies don't die on cold start
        if (!acp.sessionId) {
          try {
            await acp.start();
          } catch (e) {
            console.error(`[queue:${slot.id}] agent start failed:`, e.message);
            try {
              await acp.reset();
            } catch {
              /* ignore */
            }
          }
        }
        await runJob(job, acp);
        // Guarantee terminal status so phone poll always exits
        if (!isJobSealed(job)) {
          forceTerminalizeJob(job, {
            reason: job.error || "no terminal status",
            note: job.reply
              ? "_(Job ended without a clean terminal status — showing what the Mac had.)_"
              : false,
          });
          if (!job.reply) {
            job.reply =
              "Error: job ended without a reply. Please send again.";
            job.error = job.error || "no terminal status";
          }
          await persistJob(job);
        }
      } catch (e) {
        if (isJobSealed(job)) {
          /* phone already took ownership of the result */
        } else {
          console.error(`[queue:${slot.id}] runJob threw`, e);
          job.status = "error";
          job.error = e instanceof Error ? e.message : String(e);
          job.reply =
            (job.reply ? job.reply + "\n\n" : "") +
            `Error: ${job.error}\n\n_(Send again — this should not happen.)_`;
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          await persistJob(job);
        }
      } finally {
        if (slot.currentJobId === id) slot.currentJobId = null;
      }
    }
  } finally {
    slot.queueRunning = false;
    slot.currentJobId = null;
  }
}

/**
 * Kill the agent for the active job without re-entering processQueue.
 * The running processQueue loop owns the queue; after runJob returns
 * (userFinalized / cancelled), it continues the while-loop naturally.
 * Re-entering processQueue here used to set queueRunning=false while
 * await runJob was still in flight → concurrent agent use.
 */
async function interruptActiveAgent(jobId) {
  let slot = null;
  for (const s of allSlots()) {
    if (s.currentJobId === jobId) {
      slot = s;
      break;
    }
  }
  if (!slot) {
    // Fall back: job may record agentId
    const job = jobs.get(jobId);
    if (job?.agentId) slot = slotFor(job.agentId);
  }
  if (!slot || slot.currentJobId !== jobId) return;
  const acp = slot.acp;
  try {
    await acp.cancel();
  } catch {
    /* ignore */
  }
  try {
    await acp.reset();
  } catch {
    /* ignore */
  }
  // Do NOT clear queueRunning or call processQueue() — active loop resumes.
  // Only kick the queue if no loop is currently driving it (stuck bookkeeping).
  if (!slot.queueRunning) {
    slot.currentJobId = null;
    void processQueue(slot.id);
  }
}

/**
 * Phone "Stop & show" — end the job now with whatever reply we have so the UI unsticks.
 * Kills the agent if this is the active job so the queue can continue.
 */
async function finalizeJob(id) {
  const job = await loadJob(id);
  if (!job) return null;
  if (
    job.status === "done" ||
    job.status === "error" ||
    job.status === "cancelled"
  ) {
    return job;
  }
  const slot = slotFor(job.agentId || "main");
  const idx = slot.jobQueue.indexOf(id);
  if (idx >= 0) slot.jobQueue.splice(idx, 1);

  const partial = (job.reply || "").trim();
  // Critical: seal so runJob headless/success/stream cannot overwrite.
  sealJob(job, {
    status: partial ? "done" : "error",
    error: partial ? null : "finalized with no reply",
    reply: partial
      ? partial +
        "\n\n_(Stopped early — this is everything the Mac had so far.)_"
      : "_(Stopped — no reply text yet. Send the question again.)_",
  });
  await persistJob(job);

  await interruptActiveAgent(id);
  return job;
}

async function editQueuedJob(id, text) {
  const job = await loadJob(id);
  if (!job) return { code: 404, error: "job not found" };
  const slot = slotFor(job.agentId || "main");
  if (
    !isQueuedWaitingJob(job, slot.currentJobId) ||
    !slot.jobQueue.includes(id)
  ) {
    return { code: 409, error: "job is no longer queued" };
  }
  try {
    applyQueuedJobText(job, text);
  } catch (e) {
    return {
      code: 400,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  await persistJob(job);
  return { code: 200, job };
}

async function deleteQueuedJob(id) {
  const job = await loadJob(id);
  if (!job) return { code: 404, error: "job not found" };
  const slot = slotFor(job.agentId || "main");
  if (
    !isQueuedWaitingJob(job, slot.currentJobId) ||
    !slot.jobQueue.includes(id)
  ) {
    return { code: 409, error: "job is no longer queued" };
  }
  const idx = slot.jobQueue.indexOf(id);
  if (idx >= 0) slot.jobQueue.splice(idx, 1);
  const pending = persistChains.get(id);
  if (pending) await pending.catch(() => {});
  jobs.delete(id);
  try {
    await unlink(jobPath(id));
  } catch {
    /* already gone */
  }
  if (jobBelongsToMainConversation(job)) {
    conversation = removeJobFromConversation(conversation, id);
    await persistConversation();
  }
  return { code: 200, deleted: true, id };
}

async function handleJobPatch(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  const result = await editQueuedJob(id, body.text);
  if (result.code !== 200) {
    return sendJson(res, result.code, { error: result.error });
  }
  sendJson(res, 200, publicJob(result.job));
}

async function sendQueuedJobNow(id) {
  const job = await loadJob(id);
  if (!job) return { code: 404, error: "job not found" };
  const slot = slotFor(job.agentId || "main");
  if (
    !isQueuedWaitingJob(job, slot.currentJobId) ||
    !slot.jobQueue.includes(id)
  ) {
    return { code: 409, error: "job is no longer queued" };
  }
  promoteQueuedJob(slot.jobQueue, id);
  job.updatedAt = new Date().toISOString();
  await persistJob(job);
  if (!slot.queueRunning) void processQueue(slot.id);
  return { code: 200, job };
}

async function handleJobSendNow(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const result = await sendQueuedJobNow(id);
  if (result.code !== 200) {
    return sendJson(res, result.code, { error: result.error });
  }
  sendJson(res, 200, publicJob(result.job));
}

async function handleJobDelete(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const result = await deleteQueuedJob(id);
  if (result.code !== 200) {
    return sendJson(res, result.code, { error: result.error });
  }
  sendJson(res, 200, { deleted: true, id: result.id });
}

async function cancelJob(id) {
  const job = await loadJob(id);
  if (!job) return null;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return job;
  }
  const slot = slotFor(job.agentId || "main");
  // remove from queue if waiting
  const idx = slot.jobQueue.indexOf(id);
  if (idx >= 0) slot.jobQueue.splice(idx, 1);

  // Critical: seal so runJob cannot headless-overwrite cancelled → done.
  sealJob(job, {
    status: "cancelled",
    error: "cancelled",
    reply: job.reply || "_(cancelled)_",
  });
  await persistJob(job);

  // if this job is the hung running one, kill agent so the active queue loop continues
  if (slot.currentJobId === id || isCurrentJobAnywhere(id)) {
    // mark other stuck "running" on the same agent as cancelled
    for (const [jid, j] of jobs) {
      if (
        j.status === "running" &&
        jid !== id &&
        (j.agentId || "main") === (job.agentId || "main")
      ) {
        j.userFinalized = true;
        j.status = "error";
        j.error = "interrupted by cancel";
        j.finishedAt = new Date().toISOString();
        j.updatedAt = j.finishedAt;
        await persistJob(j);
      }
    }
    await interruptActiveAgent(id);
  }
  return job;
}

async function resetAll() {
  // Cancel everything pending on every agent slot
  for (const slot of allSlots()) {
    slot.jobQueue.length = 0;
    slot.currentJobId = null;
    slot.queueRunning = false;
  }
  for (const [, job] of jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.userFinalized = true;
      job.status = "cancelled";
      job.error = "reset";
      job.reply = job.reply || "_(reset)_";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await persistJob(job);
    }
  }
  // Kill extra concurrent agents hard; reset main to a fresh session
  try {
    await registry.stopAllExtras();
  } catch (e) {
    console.warn("[reset] stopAllExtras", e.message);
  }
  await persistAgentRoster();
  conversation = startFreshConversation(conversation);
  await agent.reset({ fresh: true });
  conversation.acpSessionId = agent.sessionId || null;
  agent.preferredSessionId = agent.sessionId || null;
  await persistConversation();
  return {
    ok: true,
    sessionId: agent.sessionId,
    conversationId: conversation.conversationId,
    clearedAt: conversation.clearedAt,
    cwd: CWD,
    agents: registry.list(),
  };
}

/**
 * POST /api/chat — enqueue on Mac, return immediately (phone may lock).
 */
async function handleChat(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") {
      return sendJson(res, 413, { error: e.message });
    }
    return sendJson(res, 400, { error: "invalid json" });
  }
  const text = String(body.text || "").trim();
  const images = Array.isArray(body.images) ? body.images : [];
  if (!text && !images.length) {
    return sendJson(res, 400, { error: "empty message" });
  }

  const imagePaths = [];
  for (const img of images.slice(0, 6)) {
    const b64 = String(img.data || img.base64 || "").replace(
      /^data:[^;]+;base64,/,
      ""
    );
    if (!b64 || b64.length < 32) continue;
    const mime = String(img.mimeType || img.type || "image/jpeg");
    const ext = mime.includes("png")
      ? "png"
      : mime.includes("webp")
        ? "webp"
        : "jpg";
    const path = join(
      INBOX,
      `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
    );
    await writeFile(path, Buffer.from(b64, "base64"));
    imagePaths.push(path);
  }

  // Route to a concurrent agent slot (default: main)
  let agentId = String(body.agentId || "main").trim() || "main";
  if (agentId === "default") agentId = "main";
  // auto: pick idle agent, or main if all busy
  if (agentId === "auto") {
    const idle = registry.list().find((a) => !a.processing && a.queueLength === 0);
    agentId = idle?.id || "main";
  }
  let slot;
  try {
    slot = registry.require(agentId);
  } catch {
    return sendJson(res, 404, { error: `agent not found: ${agentId}` });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    text,
    imagePaths,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    reply: "",
    tools: [],
    error: null,
    sessionId: null,
    agentId: slot.id,
  };
  // Only "queued" if this agent is already running or waiting — otherwise start now.
  const mustWait = slot.queueRunning || slot.jobQueue.length > 0;
  const queuePosition = mustWait ? slot.jobQueue.length + 1 : 0;
  if (!mustWait) {
    job.status = "running"; // will be set again in runJob; avoids false "queued" flash
  }
  jobs.set(id, job);
  slot.jobQueue.push(id);
  registry.touch(slot.id);
  await persistJob(job);
  void processQueue(slot.id);

  sendJson(res, 202, {
    jobId: id,
    status: mustWait ? "queued" : "running",
    queuePosition,
    agentId: slot.id,
    agentLabel: slot.label,
    cwd: slot.cwd || CWD,
  });
}

async function handleJobGet(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const job = await loadJob(id);
  if (!job) return sendJson(res, 404, { error: "job not found" });
  sendJson(res, 200, publicJob(job));
}

/**
 * GET /api/jobs/:id/stream — Server-Sent Events (push) for live job updates.
 * Prefer this over polling: final replies arrive the moment the Mac finishes.
 * Auth via Authorization header or ?token= (EventSource cannot set headers).
 */
async function handleJobStream(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const job = await loadJob(id);
  if (!job) return sendJson(res, 404, { error: "job not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Hello + current snapshot immediately
  res.write(`event: hello\ndata: ${JSON.stringify({ jobId: id })}\n\n`);
  res.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);

  if (
    job.status === "done" ||
    job.status === "error" ||
    job.status === "cancelled"
  ) {
    res.write(`event: end\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    res.end();
    return;
  }

  subscribeJob(id, res);

  // Heartbeat so mobile Safari / proxies don't drop the stream
  const beat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(beat);
    }
  }, 15000);
  res.on("close", () => clearInterval(beat));
}

async function handleJobsList(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const list = [...jobs.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 40)
    .map(publicJob);
  const active = list.filter(
    (j) => j.status === "running" || j.status === "queued"
  );
  sendJson(res, 200, {
    jobs: list,
    active,
    queueLength: totalQueueLength(),
    processing: anyQueueRunning(),
    agents: registry.list(),
    maxAgents: registry.maxAgents,
    standupUnread: standup.unreadCount(),
  });
}

/** Filled when free local HTTPS is listening (for phone live mic). */
let httpsListenInfo = null;

async function handleStatus(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const agents = registry.list();
  const lanIps = listLanIPv4();
  sendJson(res, 200, {
    ok: true,
    cwd: CWD,
    sessionId: agent.sessionId,
    sessionResumed: !!agent.sessionResumed,
    conversationId: conversation.conversationId,
    agentReady: !!agent.sessionId,
    queueLength: totalQueueLength(),
    processing: anyQueueRunning(),
    currentJobId: getMainCurrentJobId(),
    currentJobIds: agents.map((a) => a.currentJobId).filter(Boolean),
    agents,
    agentCount: agents.length,
    maxAgents: registry.maxAgents,
    turnCount: conversation.turns?.length || 0,
    httpPort: PORT,
    httpsPort: httpsListenInfo?.port || null,
    httpsEnabled: !!httpsListenInfo,
    lanIps,
    // Free self-signed — no paid Tailscale Serve required for live mic
    liveMicHint: httpsListenInfo
      ? `For live in-page mic on iPhone, open https://<mac-ip>:${httpsListenInfo.port} once (trust the free cert), then re-add to Home Screen.`
      : null,
    standupUnread: standup.unreadCount(),
  });
}

/**
 * GET /api/conversation — host-backed transcript for phone reconnect.
 * Always returns durable turns (from phone-conversation.json + jobs) so the
 * UI reloads text even after bridge restart / localStorage wipe.
 */
async function handleConversation(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  // Refresh from disk jobs so partial replies mid-turn are included
  try {
    conversation = await rebuildConversationFromJobs(JOBS_DIR, conversation);
  } catch {
    /* keep memory */
  }
  const messages = conversationToMessages(conversation, 80);
  const activeJobs = [...jobs.values()]
    .filter(
      (j) =>
        j.status === "running" ||
        j.status === "queued" ||
        // also surface very recent terminal jobs so reconnect can show final body
        (isTerminalJobStatus(j.status) &&
          Date.now() - (Date.parse(j.finishedAt || j.updatedAt || 0) || 0) <
            10 * 60 * 1000)
    )
    .sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    )
    .slice(0, 20)
    .map(publicJob);

  sendJson(res, 200, {
    conversationId: conversation.conversationId,
    acpSessionId: agent.sessionId || conversation.acpSessionId,
    sessionResumed: !!agent.sessionResumed,
    clearedAt: conversation.clearedAt || null,
    messages,
    turns: conversation.turns.slice(-80),
    activeJobs,
    currentJobId: getMainCurrentJobId(),
    currentJobIds: registry.list().map((a) => a.currentJobId).filter(Boolean),
    processing: anyQueueRunning(),
    agents: registry.list(),
  });
}

/**
 * Cancel all queued/running jobs for one agent, then hard-stop the Mac process.
 * @param {string} agentId
 * @param {{ remove?: boolean }} [opts]
 */
async function stopAgentHard(agentId, opts = {}) {
  const slot = registry.require(agentId);
  const pending = [];
  for (const [jid, j] of jobs) {
    if ((j.agentId || "main") !== slot.id) continue;
    if (j.status === "queued" || j.status === "running") pending.push(jid);
  }
  for (const jid of pending) {
    try {
      await cancelJob(jid);
    } catch (e) {
      console.warn("[agents] cancel on stop", jid, e.message);
    }
  }
  // Drain queue bookkeeping then kill process (process group)
  slot.jobQueue.length = 0;
  slot.currentJobId = null;
  slot.queueRunning = false;
  const out = await registry.stop(slot.id, {
    remove: !!opts.remove && !slot.isMain,
  });
  await persistAgentRoster();
  return out;
}

function handleStandupFeed(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const limit = Number(url.searchParams.get("limit") || 80);
  sendJson(res, 200, getFeedPayload(standup, limit));
}

function handleStandupPostGet(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const post = standup.getPost(id);
  if (!post) return sendJson(res, 404, { error: "not found" });
  sendJson(res, 200, { post, pins: standup.getPins() });
}

async function handleStandupCreate(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") {
      return sendJson(res, 413, { error: e.message });
    }
    return sendJson(res, 400, { error: "invalid json" });
  }
  try {
    const post = standup.createPost(body);
    if (body.loopId) {
      try {
        recordLoopRun(LOOPS_STATE_PATH, String(body.loopId), {
          status: "ok",
          summary: post.bodyShort,
        });
        upsertBrief(BRIEFS_PATH, {
          loopId: String(body.loopId),
          agentName: post.agentName,
          title: post.title,
          bodyShort: post.bodyShort,
          bodyLong: post.bodyLong || post.bodyShort,
          kind: post.kind,
          postId: post.id,
          jobId: post.jobId,
        });
      } catch {
        /* last-run / brief stamp is best-effort */
      }
    }
    sendJson(res, 201, { post, unreadCount: standup.unreadCount() });
  } catch (e) {
    const code = e?.code === "BAD_POST" ? 400 : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "ERROR",
    });
  }
}

async function handleStandupRead(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  const unreadCount = body.all
    ? standup.markRead("all")
    : standup.markRead(body.ids || []);
  sendJson(res, 200, { unreadCount });
}

async function handleStandupPins(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  if (!body.key) return sendJson(res, 400, { error: "key is required" });
  try {
    const pins = standup.setPin(body.key, body.value);
    sendJson(res, 200, { pins });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function handleLoopsList(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const catalog = readLocalLoops(LOOPS_PATH);
  const state = readLoopState(LOOPS_STATE_PATH);
  const briefs = readAllBriefs(BRIEFS_PATH);
  const loops = listLoops(catalog.loops, state).map((loop) => {
    const brief = briefs[loop.id] || null;
    return {
      ...loop,
      lastBriefAt: brief?.updatedAt || null,
      readsFrom: loop.role === "synth" ? loop.reads : [],
    };
  });
  sendJson(res, 200, {
    loops,
    source: catalog.source,
    hint:
      catalog.source === "missing"
        ? "Copy examples/phone-loops.example.json to ~/.grok/phone-loops.json"
        : null,
  });
}

function handleBriefsList(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  sendJson(res, 200, { briefs: readAllBriefs(BRIEFS_PATH) });
}

function handleBriefGet(req, res, loopId) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const brief = readBrief(BRIEFS_PATH, loopId);
  if (!brief) return sendJson(res, 404, { error: "not found" });
  sendJson(res, 200, { brief });
}

function handleLoopInputs(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const catalog = readLocalLoops(LOOPS_PATH);
  const loop = catalog.loops.find((l) => l.id === id);
  if (!loop) return sendJson(res, 404, { error: "loop not found" });
  const inputs = gatherSynthInputs(loop, catalog.loops, readAllBriefs(BRIEFS_PATH));
  sendJson(res, 200, { loopId: loop.id, role: loop.role, inputs });
}

const loopInFlight = new Set();

function commitLoopOutput(loop, job) {
  const parsed = parseLoopReport(job.reply);
  if (!parsed.bodyShort) {
    throw Object.assign(new Error("loop reply had no SHORT card"), {
      code: "BAD_REPORT",
    });
  }
  const post = standup.createPost({
    agentName: loop.name,
    agentId: loop.id,
    kind:
      parsed.kind ||
      loop.kind ||
      (loop.role === "synth" ? "standup" : "update"),
    title: parsed.title || "",
    bodyShort: parsed.bodyShort,
    bodyLong: parsed.bodyLong || parsed.bodyShort,
    jobId: job.id,
  });
  upsertBrief(BRIEFS_PATH, {
    loopId: loop.id,
    agentName: loop.name,
    title: post.title,
    bodyShort: post.bodyShort,
    bodyLong: post.bodyLong,
    kind: post.kind,
    postId: post.id,
    jobId: job.id,
  });
  recordLoopRun(LOOPS_STATE_PATH, loop.id, {
    status: "ok",
    summary: post.bodyShort,
  });
  return post;
}

async function runScheduledLoop(loop, opts = {}) {
  if (!loop?.id) return { error: "no loop" };
  if (loopInFlight.has(loop.id)) return { error: "already running", loopId: loop.id };
  loopInFlight.add(loop.id);
  recordLoopRun(LOOPS_STATE_PATH, loop.id, {
    status: "running",
    summary: opts.reason === "manual" ? "Manual run…" : "Running…",
  });
  const catalog = readLocalLoops(LOOPS_PATH).loops;
  const briefs = readAllBriefs(BRIEFS_PATH);
  const pins = standup.getPins();
  const prompt =
    loop.role === "synth"
      ? buildSynthPrompt(loop, gatherSynthInputs(loop, catalog, briefs), pins)
      : buildSpecialistPrompt(loop, pins);
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: "running",
    text: prompt,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    reply: "",
    tools: [],
    error: null,
    sessionId: null,
    agentId: "loops",
    loopId: loop.id,
    loopName: loop.name,
    source: "loop",
  };
  jobs.set(id, job);
  await persistJob(job);
  try {
    const reply = await runHeadlessPrompt(prompt, CWD, 15 * 60 * 1000);
    job.reply = reply;
    job.status = "done";
    job.error = null;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await persistJob(job);
    const post = commitLoopOutput(loop, job);
    return { jobId: id, post, loopId: loop.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    job.status = "error";
    job.error = msg;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await persistJob(job);
    recordLoopRun(LOOPS_STATE_PATH, loop.id, {
      status: "error",
      summary: msg.slice(0, 200),
    });
    return { error: msg, jobId: id, loopId: loop.id };
  } finally {
    loopInFlight.delete(loop.id);
  }
}

async function tickDueLoops() {
  const catalog = readLocalLoops(LOOPS_PATH);
  if (catalog.source !== "local") return;
  const state = readLoopState(LOOPS_STATE_PATH);
  const now = Date.now();
  for (const loop of catalog.loops) {
    if (!loop.enabled) continue;
    if (loopInFlight.has(loop.id)) continue;
    const last = state[loop.id]?.lastRunAt || null;
    if (!isLoopDue(loop.schedule, last, now)) continue;
    console.log(`[loops] due ${loop.id}`);
    void runScheduledLoop(loop, { reason: "schedule" }).then((r) => {
      if (r?.error) console.warn(`[loops] ${loop.id} failed:`, r.error);
      else console.log(`[loops] ${loop.id} posted ${r?.post?.id || ""}`);
    });
  }
}

function handleLoopRun(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const catalog = readLocalLoops(LOOPS_PATH);
  const loop = catalog.loops.find((l) => l.id === id);
  if (!loop) return sendJson(res, 404, { error: "loop not found" });
  if (loopInFlight.has(loop.id)) {
    return sendJson(res, 409, { error: "already running", loopId: loop.id });
  }
  void runScheduledLoop(loop, { reason: "manual" }).then((r) => {
    if (r?.error) console.warn(`[loops] ${loop.id} failed:`, r.error);
  });
  sendJson(res, 202, { loopId: loop.id, started: true });
}

/** GET /api/agents */
async function handleAgentsList(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  sendJson(res, 200, {
    agents: registry.list(),
    maxAgents: registry.maxAgents,
    count: registry.size,
  });
}

/** POST /api/agents — spawn a concurrent agent process on the Mac */
async function handleAgentCreate(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") {
      return sendJson(res, 413, { error: e.message });
    }
    return sendJson(res, 400, { error: "invalid json" });
  }
  try {
    const created = registry.create({
      label: body.label,
      cwd: body.cwd,
    });
    await persistAgentRoster();
    // Warm-start ACP process so Activity shows alive quickly
    const slot = registry.get(created.id);
    if (slot?.acp) {
      void slot.acp.start()
        .then(() => persistAgentRoster())
        .catch((e) =>
          console.warn("[agents] start failed", created.id, e.message)
        );
    }
    sendJson(res, 201, { agent: created, agents: registry.list() });
  } catch (e) {
    const code = e?.code === "MAX_AGENTS" ? 409 : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "ERROR",
    });
  }
}

/**
 * PATCH /api/agents/:id — rename (and future metadata).
 * Body: { label: string }
 * Also accepted as POST /api/agents/:id/rename for simple clients.
 */
async function handleAgentRename(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") {
      return sendJson(res, 413, { error: e.message });
    }
    return sendJson(res, 400, { error: "invalid json" });
  }
  if (body.label === undefined || body.label === null) {
    return sendJson(res, 400, {
      error: "label is required",
      code: "INVALID_LABEL",
    });
  }
  try {
    const agent = registry.rename(id, body.label);
    await persistAgentRoster();
    sendJson(res, 200, { agent, agents: registry.list() });
  } catch (e) {
    const code =
      e?.code === "AGENT_NOT_FOUND"
        ? 404
        : e?.code === "INVALID_LABEL"
          ? 400
          : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "ERROR",
    });
  }
}

/**
 * POST /api/agents/:id/stop — hard-stop on Mac (cancels jobs + kills process).
 * Body: { remove?: boolean } — remove extra agents from registry (default true for extras).
 */
async function handleAgentStop(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    body = {};
  }
  try {
    const slot = registry.require(id);
    // Extras: default remove=true so "close" frees the slot. Main: reset only.
    const remove = slot.isMain
      ? false
      : body.remove !== undefined
        ? !!body.remove
        : true;
    const out = await stopAgentHard(id, { remove });
    sendJson(res, 200, { ...out, agents: registry.list() });
  } catch (e) {
    const code = e?.code === "AGENT_NOT_FOUND" ? 404 : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "ERROR",
    });
  }
}

/** DELETE /api/agents/:id — same as stop with remove for extras */
async function handleAgentDelete(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  try {
    const slot = registry.require(id);
    const out = await stopAgentHard(id, { remove: !slot.isMain });
    sendJson(res, 200, { ...out, agents: registry.list() });
  } catch (e) {
    const code = e?.code === "AGENT_NOT_FOUND" ? 404 : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "ERROR",
    });
  }
}

/** POST /api/reset — kill agent + cancel all jobs (phone unstick). */
async function handleReset(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  try {
    const out = await resetAll();
    sendJson(res, 200, out);
  } catch (e) {
    sendJson(res, 500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** POST /api/jobs/:id/cancel */
async function handleJobCancel(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const job = await cancelJob(id);
  if (!job) return sendJson(res, 404, { error: "job not found" });
  sendJson(res, 200, publicJob(job));
}

/** POST /api/jobs/:id/finalize — stop job and return whatever reply exists (phone "Stop & show"). */
async function handleJobFinalize(req, res, id) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const job = await finalizeJob(id);
  if (!job) return sendJson(res, 404, { error: "job not found" });
  sendJson(res, 200, publicJob(job));
}

/** GET /api/jobs/:id/media/:index — serve a generated image for the phone UI. */
async function handleJobMedia(req, res, id, indexStr) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const job = await loadJob(id);
  if (!job) return sendJson(res, 404, { error: "job not found" });
  const imgs = Array.isArray(job.replyImages) ? job.replyImages : [];
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0 || index >= imgs.length) {
    return sendJson(res, 404, { error: "image not found" });
  }
  const abs = resolve(String(imgs[index]));
  if (!isAllowedMediaPath(abs) || !existsSync(abs)) {
    return sendJson(res, 404, { error: "image file missing" });
  }
  const ext = extname(abs).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".tif" || ext === ".tiff"
            ? "image/tiff"
            : "image/jpeg";
  try {
    const st = statSync(abs);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(abs).pipe(res);
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
}

/** Grok TUI / CLI slash commands (shown under `/` on phone). */
const CLI_SLASH_CATALOG = [
  { id: "cli-usage", slash: "/usage", label: "Usage", description: "Live credit usage (instant, no agent)", insert: "/usage", kind: "cli" },
  { id: "cli-cost", slash: "/cost", label: "Cost", description: "Alias for /usage (instant)", insert: "/cost", kind: "cli" },
  { id: "cli-session-info", slash: "/session-info", label: "Session info", description: "Auth, model, turns, context (aliases /status /info)", insert: "/session-info", kind: "cli" },
  { id: "cli-status", slash: "/status", label: "Status", description: "Alias for /session-info", insert: "/status", kind: "cli" },
  { id: "cli-info", slash: "/info", label: "Info", description: "Alias for /session-info", insert: "/info", kind: "cli" },
  { id: "cli-context", slash: "/context", label: "Context", description: "Context window breakdown", insert: "/context", kind: "cli" },
  { id: "cli-compact", slash: "/compact", label: "Compact", description: "Compress conversation history", insert: "/compact ", kind: "cli" },
  { id: "cli-new", slash: "/new", label: "New session", description: "Start a fresh session (alias /clear)", insert: "/new", kind: "cli" },
  { id: "cli-clear", slash: "/clear", label: "Clear", description: "Alias for /new", insert: "/clear", kind: "cli" },
  { id: "cli-rename", slash: "/rename", label: "Rename", description: "Rename session (alias /title)", insert: "/rename ", kind: "cli" },
  { id: "cli-export", slash: "/export", label: "Export", description: "Export conversation", insert: "/export", kind: "cli" },
  { id: "cli-copy", slash: "/copy", label: "Copy", description: "Copy last reply", insert: "/copy", kind: "cli" },
  { id: "cli-model", slash: "/model", label: "Model", description: "Switch model (alias /m)", insert: "/model ", kind: "cli" },
  { id: "cli-effort", slash: "/effort", label: "Effort", description: "Set reasoning effort", insert: "/effort ", kind: "cli" },
  { id: "cli-plan", slash: "/plan", label: "Plan mode", description: "Enter plan mode", insert: "/plan ", kind: "cli" },
  { id: "cli-view-plan", slash: "/view-plan", label: "View plan", description: "Preview saved plan", insert: "/view-plan", kind: "cli" },
  { id: "cli-always-approve", slash: "/always-approve", label: "Always approve", description: "Toggle yolo permissions", insert: "/always-approve", kind: "cli" },
  { id: "cli-auto", slash: "/auto", label: "Auto mode", description: "Toggle auto permission mode", insert: "/auto", kind: "cli" },
  { id: "cli-skills", slash: "/skills", label: "Skills", description: "Browse skills", insert: "/skills", kind: "cli" },
  { id: "cli-mcps", slash: "/mcps", label: "MCPs", description: "List MCP servers", insert: "/mcps", kind: "cli" },
  { id: "cli-plugins", slash: "/plugins", label: "Plugins", description: "Manage plugins", insert: "/plugins", kind: "cli" },
  { id: "cli-hooks", slash: "/hooks", label: "Hooks", description: "Manage hooks", insert: "/hooks", kind: "cli" },
  { id: "cli-doctor", slash: "/doctor", label: "Doctor", description: "Diagnostics", insert: "/doctor", kind: "cli" },
  { id: "cli-docs", slash: "/docs", label: "Docs", description: "Open documentation", insert: "/docs", kind: "cli" },
  { id: "cli-release-notes", slash: "/release-notes", label: "Release notes", description: "What's new", insert: "/release-notes", kind: "cli" },
  { id: "cli-feedback", slash: "/feedback", label: "Feedback", description: "Send feedback", insert: "/feedback ", kind: "cli" },
  { id: "cli-privacy", slash: "/privacy", label: "Privacy", description: "Data retention / training settings", insert: "/privacy", kind: "cli" },
  { id: "cli-settings", slash: "/settings", label: "Settings", description: "Open settings (aliases /config /prefs)", insert: "/settings", kind: "cli" },
  { id: "cli-login", slash: "/login", label: "Login", description: "Authenticate", insert: "/login", kind: "cli" },
  { id: "cli-logout", slash: "/logout", label: "Logout", description: "Sign out", insert: "/logout", kind: "cli" },
  { id: "cli-memory", slash: "/memory", label: "Memory", description: "Browse memory (alias /mem)", insert: "/memory", kind: "cli" },
  { id: "cli-remember", slash: "/remember", label: "Remember", description: "Save a note to memory", insert: "/remember ", kind: "cli" },
  { id: "cli-flush", slash: "/flush", label: "Flush memory", description: "Save session knowledge now", insert: "/flush", kind: "cli" },
  { id: "cli-dream", slash: "/dream", label: "Dream", description: "Consolidate memory", insert: "/dream", kind: "cli" },
  { id: "cli-imagine", slash: "/imagine", label: "Imagine", description: "CLI image generation command", insert: "/imagine ", kind: "cli" },
  { id: "cli-imagine-video", slash: "/imagine-video", label: "Imagine video", description: "CLI video generation", insert: "/imagine-video ", kind: "cli" },
  { id: "cli-deep-research", slash: "/deep-research", label: "Deep research", description: "Deep research workflow", insert: "/deep-research ", kind: "cli" },
  { id: "cli-workflow", slash: "/workflow", label: "Workflow", description: "Workflow commands", insert: "/workflow ", kind: "cli" },
  { id: "cli-workflows", slash: "/workflows", label: "Workflows dashboard", description: "Live workflow runs", insert: "/workflows", kind: "cli" },
  { id: "cli-goal", slash: "/goal", label: "Goal", description: "Goal harness commands", insert: "/goal ", kind: "cli" },
  { id: "cli-loop", slash: "/loop", label: "Loop", description: "Recurring prompt loop", insert: "/loop ", kind: "cli" },
  { id: "cli-help", slash: "/help", label: "Help", description: "List phone + CLI commands", insert: "/help", kind: "cli" },
];

/** Built-in agent tools (tool-loop capabilities). */
const AGENT_TOOL_CATALOG = [
  { id: "run_terminal_command", slash: "/tool-shell", label: "Tool: Shell", description: "run_terminal_command", insert: "Use run_terminal_command to: ", kind: "tool" },
  { id: "read_file", slash: "/tool-read", label: "Tool: Read file", description: "read_file", insert: "Use read_file on: ", kind: "tool" },
  { id: "write", slash: "/tool-write", label: "Tool: Write file", description: "write", insert: "Use write to create/overwrite: ", kind: "tool" },
  { id: "search_replace", slash: "/tool-edit", label: "Tool: Edit file", description: "search_replace", insert: "Use search_replace to edit: ", kind: "tool" },
  { id: "grep", slash: "/tool-grep", label: "Tool: Grep", description: "grep", insert: "Use grep to find: ", kind: "tool" },
  { id: "list_dir", slash: "/tool-ls", label: "Tool: List dir", description: "list_dir", insert: "Use list_dir on: ", kind: "tool" },
  { id: "todo_write", slash: "/tool-todo", label: "Tool: Todos", description: "todo_write", insert: "Use todo_write to track: ", kind: "tool" },
  { id: "spawn_subagent", slash: "/tool-agent", label: "Tool: Subagent", description: "spawn_subagent", insert: "Use spawn_subagent to: ", kind: "tool" },
  { id: "get_command_or_subagent_output", slash: "/tool-task-out", label: "Tool: Task output", description: "get_command_or_subagent_output", insert: "Use get_command_or_subagent_output for: ", kind: "tool" },
  { id: "kill_command_or_subagent", slash: "/tool-kill", label: "Tool: Kill task", description: "kill_command_or_subagent", insert: "Use kill_command_or_subagent on: ", kind: "tool" },
  { id: "monitor", slash: "/tool-monitor", label: "Tool: Monitor", description: "monitor", insert: "Use monitor to watch: ", kind: "tool" },
  { id: "scheduler_create", slash: "/tool-schedule", label: "Tool: Schedule", description: "scheduler_create", insert: "Use scheduler_create to: ", kind: "tool" },
  { id: "scheduler_list", slash: "/tool-schedules", label: "Tool: List schedules", description: "scheduler_list", insert: "Use scheduler_list and summarize.", kind: "tool" },
  { id: "scheduler_delete", slash: "/tool-unschedule", label: "Tool: Delete schedule", description: "scheduler_delete", insert: "Use scheduler_delete for id: ", kind: "tool" },
  { id: "web_search", slash: "/tool-search", label: "Tool: Web search", description: "web_search", insert: "Use web_search for: ", kind: "tool" },
  { id: "web_fetch", slash: "/tool-fetch", label: "Tool: Fetch URL", description: "web_fetch", insert: "Use web_fetch on: ", kind: "tool" },
  { id: "open_page", slash: "/tool-page", label: "Tool: Open page", description: "open_page", insert: "Use open_page on: ", kind: "tool" },
  { id: "open_page_with_find", slash: "/tool-page-find", label: "Tool: Page find", description: "open_page_with_find", insert: "Use open_page_with_find on: ", kind: "tool" },
  { id: "x_user_search", slash: "/tool-x-user", label: "Tool: X user", description: "x_user_search", insert: "Use x_user_search for: ", kind: "tool" },
  { id: "x_semantic_search", slash: "/tool-x-sem", label: "Tool: X semantic", description: "x_semantic_search", insert: "Use x_semantic_search for: ", kind: "tool" },
  { id: "x_keyword_search", slash: "/tool-x", label: "Tool: X keyword", description: "x_keyword_search", insert: "Use x_keyword_search for: ", kind: "tool" },
  { id: "x_thread_fetch", slash: "/tool-x-thread", label: "Tool: X thread", description: "x_thread_fetch", insert: "Use x_thread_fetch for post_id: ", kind: "tool" },
  { id: "image_gen", slash: "/tool-imagine", label: "Tool: Image gen", description: "image_gen", insert: "Use image_gen to create: ", kind: "tool" },
  { id: "image_edit", slash: "/tool-img-edit", label: "Tool: Image edit", description: "image_edit", insert: "Use image_edit on the attached image: ", kind: "tool" },
  { id: "image_to_video", slash: "/tool-i2v", label: "Tool: Image→video", description: "image_to_video", insert: "Use image_to_video on: ", kind: "tool" },
  { id: "reference_to_video", slash: "/tool-ref2v", label: "Tool: Refs→video", description: "reference_to_video", insert: "Use reference_to_video with images: ", kind: "tool" },
  { id: "enter_plan_mode", slash: "/tool-plan", label: "Tool: Enter plan", description: "enter_plan_mode", insert: "Use enter_plan_mode, then plan: ", kind: "tool" },
  { id: "exit_plan_mode", slash: "/tool-plan-exit", label: "Tool: Exit plan", description: "exit_plan_mode", insert: "Use exit_plan_mode when the plan is ready.", kind: "tool" },
  { id: "ask_user_question", slash: "/tool-ask", label: "Tool: Ask me", description: "ask_user_question", insert: "Use ask_user_question to ask me: ", kind: "tool" },
  { id: "search_tool", slash: "/tool-mcp-search", label: "Tool: MCP search", description: "search_tool", insert: "Use search_tool to find MCP tools for: ", kind: "tool" },
  { id: "use_tool", slash: "/tool-mcp", label: "Tool: MCP call", description: "use_tool", insert: "Use use_tool for: ", kind: "tool" },
  { id: "workflow", slash: "/tool-workflow", label: "Tool: Workflow", description: "workflow", insert: "Use workflow to run: ", kind: "tool" },
];

function fullCatalog() {
  return [...CLI_SLASH_CATALOG, ...AGENT_TOOL_CATALOG];
}

/**
 * Handle phone-local slash commands without the agent when possible.
 * Returns markdown string or null to fall through to agent.
 */
async function tryLocalSlashCommand(text) {
  const line = String(text || "").trim();
  if (!line.startsWith("/")) return null;
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  if (cmd === "/help" || cmd === "/commands") {
    const cli = CLI_SLASH_CATALOG.map((c) => `- \`${c.slash}\` — ${c.description}`).join("\n");
    const tools = AGENT_TOOL_CATALOG.map((c) => `- \`${c.slash}\` — ${c.description}`).join("\n");
    return `## Commands\n\n### CLI\n${cli}\n\n### Agent tools\n${tools}\n\nType \`/\` in the composer to search.`;
  }

  if (cmd === "/session-info" || cmd === "/status" || cmd === "/info") {
    return [
      "## Session info (phone bridge)",
      "",
      `- **cwd:** \`${CWD}\``,
      `- **agent session:** \`${agent.sessionId || "(starting)"}\``,
      `- **queue:** ${totalQueueLength()} waiting, processing=${anyQueueRunning()}`,
      `- **agents:** ${registry.size} / ${registry.maxAgents}`,
      `- **jobs dir:** \`${JOBS_DIR}\``,
      "",
      "This is the phone-bridge agent, not the TUI session on your Mac desktop.",
    ].join("\n");
  }

  if (cmd === "/context") {
    return [
      "## Context",
      "",
      `- Workspace: \`${CWD}\``,
      `- Agent tools and MCP servers are available in this process.`,
      `- Phone history is stored on your device; Mac jobs are in \`${JOBS_DIR}\`.`,
      "",
      "For a full token breakdown like the TUI `/context`, ask me to estimate usage or open the TUI.",
    ].join("\n");
  }

  if (cmd === "/usage" || cmd === "/cost") {
    // Handled earlier via isUsageIntent — keep as safety net
    return formatUsageReport();
  }

  if (cmd === "/new" || cmd === "/clear") {
    // New epoch: drop durable transcript so old usage/test jobs don't reappear on open
    conversation = startFreshConversation(conversation);
    await agent.reset({ fresh: true });
    conversation.acpSessionId = agent.sessionId || null;
    agent.preferredSessionId = agent.sessionId || null;
    await persistConversation();
    return [
      "## New session",
      "",
      `- Fresh agent session: \`${agent.sessionId || "(starting)"}\``,
      `- Conversation cleared (id \`${conversation.conversationId.slice(0, 8)}…\`)`,
      `- cwd: \`${CWD}\``,
      "",
      "Prior phone history was cleared on the Mac. Re-open the app or unlock to sync an empty transcript on the phone.",
      "",
      "<!-- phone-clear-history -->",
    ].join("\n");
  }

  if (cmd === "/mcps") {
    return null; // agent can list via tools
  }

  if (cmd === "/doctor") {
    return null;
  }

  // TUI-only UI commands — explain
  const tuiOnly = new Set([
    "/dashboard",
    "/agents-dashboard",
    "/sessions",
    "/resume",
    "/home",
    "/welcome",
    "/quit",
    "/exit",
    "/delete",
    "/fork",
    "/rewind",
    "/undo",
    "/edit-prompt",
    "/multiline",
    "/ml",
    "/history",
    "/compact-mode",
    "/vim-mode",
    "/minimal",
    "/fullscreen",
    "/full",
    "/theme",
    "/timestamps",
    "/settings",
    "/config",
    "/preferences",
    "/prefs",
    "/privacy",
    "/login",
    "/logout",
    "/tutorial",
    "/btw",
  ]);
  if (tuiOnly.has(cmd)) {
    return [
      `\`${cmd}\` is a **TUI-only** command (desktop Grok Build UI).`,
      "",
      "On phone you can use agent tools via `/tool-*` or just ask in plain language.",
      "For billing/usage try **`/usage`** (instant — does not use the agent).",
      arg ? `\n(You also passed: ${arg})` : "",
    ].join("\n");
  }

  return null;
}

/**
 * Map some slashes to agent instructions. Prefer sending native ACP slash
 * commands as-is when the agent implements them (/session-info works).
 * Never expand /usage — that is handled locally.
 */
function expandSlashForAgent(text) {
  const line = String(text || "").trim();
  const m = line.match(/^(\/[^\s]+)(?:\s+(.*))?$/s);
  if (!m) return text;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();

  // Native agent slash commands — send raw so slash_exec can answer instantly
  const nativePassThrough = new Set([
    "/session-info",
    "/status",
    "/info",
    "/context",
    "/compact",
    "/always-approve",
    "/effort",
    "/deep-research",
    "/workflow",
    "/goal",
  ]);
  if (nativePassThrough.has(cmd)) {
    return line;
  }

  if (cmd === "/doctor") {
    return "The user ran /doctor. Run diagnostics on the environment (node, git, grok auth if possible) and summarize health.";
  }
  if (cmd === "/mcps") {
    return "The user ran /mcps. List connected MCP servers and notable tools (use search_tool as needed).";
  }
  if (cmd === "/skills") {
    return "The user ran /skills. List available skills under ~/.grok/skills, bundled skills, and project .grok/skills.";
  }
  if (cmd === "/imagine") {
    return arg
      ? `Use image_gen to generate an image: ${arg}`
      : "Ask what image to generate, then use image_gen.";
  }
  if (cmd === "/imagine-video") {
    return arg
      ? `Plan and generate a video (image_gen + image_to_video as needed): ${arg}`
      : "Ask what video to generate.";
  }
  if (cmd === "/remember") {
    return arg
      ? `Remember this for future sessions (note it clearly): ${arg}`
      : "Ask what I should remember.";
  }
  if (cmd === "/model" || cmd === "/m") {
    return arg
      ? `Note: user requested model switch to ${arg}. Explain how to switch models in TUI (/model) and continue with current model unless you can switch.`
      : "Explain current model and how /model works in the TUI.";
  }
  if (cmd === "/plan") {
    return arg
      ? `Enter planning mindset (enter_plan_mode if useful) and plan: ${arg}`
      : "Enter plan mode / draft a plan for the next task — ask what to plan if unclear.";
  }
  // Unknown slash → still send to agent as explicit command
  if (line.startsWith("/")) {
    return `The user invoked slash command: ${line}\nHandle it if you can, or explain how it works in Grok Build.`;
  }
  return text;
}

async function handleTools(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  const tools = fullCatalog();
  sendJson(res, 200, {
    cwd: CWD,
    tools,
    counts: {
      cli: CLI_SLASH_CATALOG.length,
      agentTools: AGENT_TOOL_CATALOG.length,
      total: tools.length,
    },
  });
}

// ─── Phone dictation: MediaRecorder / voice-memo → Mac transcription ────────
// iOS PWAs lack webkitSpeechRecognition; http:// uses native audio file picker.
// Shared pipeline lives in lib/dictation.mjs (unit-tested).

const DICTATION_DIR = join(homedir(), ".grok", "phone-dictation");
const DICTATION_MAX_BYTES = Number(
  process.env.PHONE_CHAT_DICTATION_MAX_BYTES || 8 * 1024 * 1024
);

/**
 * POST /api/dictation
 * Body: raw audio bytes (webm/mp4/m4a/wav/caf) — Content-Type indicates format.
 * Query/header: locale optional.
 */
async function handleDictation(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
  let buf;
  try {
    buf = await readBody(req, DICTATION_MAX_BYTES);
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") {
      return sendJson(res, 413, { error: e.message });
    }
    return sendJson(res, 400, { error: "failed to read body" });
  }
  if (!buf || !buf.length) {
    return sendJson(res, 400, { error: "empty audio", code: "EMPTY_AUDIO" });
  }

  const ctype = String(req.headers["content-type"] || "");
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const locale =
    url.searchParams.get("locale") ||
    req.headers["x-speech-locale"] ||
    "en-US";

  try {
    const result = await processDictationAudio(buf, {
      contentType: ctype,
      locale: String(locale),
      workDir: DICTATION_DIR,
      cwd: CWD,
    });
    const payload = normalizeDictationSuccess(result);
    sendJson(res, 200, payload);
  } catch (e) {
    console.error("[dictation]", e.message || e);
    const code = e?.code === "EMPTY_AUDIO" || e?.code === "EMPTY_TRANSCRIPT" ? 400 : 500;
    sendJson(res, code, {
      error: e instanceof Error ? e.message : String(e),
      code: e?.code || "DICTATION_FAILED",
    });
  }
}

function serveStatic(req, res) {
  let path = (req.url || "/").split("?")[0];
  if (path === "/") path = "/index.html";
  const file = join(PUBLIC, path.replace(/\.\./g, ""));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function onRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }
  const url = req.url || "/";
  const pathOnly = url.split("?")[0];
  try {
    if (req.method === "POST" && pathOnly === "/api/chat") {
      return await handleChat(req, res);
    }
    if (req.method === "POST" && pathOnly === "/api/dictation") {
      return await handleDictation(req, res);
    }
    if (req.method === "POST" && pathOnly === "/api/reset") {
      return await handleReset(req, res);
    }
    if (req.method === "GET" && pathOnly === "/api/status") {
      return await handleStatus(req, res);
    }
    if (req.method === "GET" && pathOnly === "/api/conversation") {
      return await handleConversation(req, res);
    }
    if (req.method === "GET" && pathOnly === "/api/tools") {
      return await handleTools(req, res);
    }
    if (req.method === "GET" && pathOnly === "/api/agents") {
      return await handleAgentsList(req, res);
    }
    if (req.method === "POST" && pathOnly === "/api/agents") {
      return await handleAgentCreate(req, res);
    }
    const agentStop = pathOnly.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/stop$/);
    if (req.method === "POST" && agentStop) {
      return await handleAgentStop(req, res, agentStop[1]);
    }
    const agentRename = pathOnly.match(
      /^\/api\/agents\/([a-zA-Z0-9_-]+)\/rename$/
    );
    if (req.method === "POST" && agentRename) {
      return await handleAgentRename(req, res, agentRename[1]);
    }
    const agentPatch = pathOnly.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "PATCH" && agentPatch) {
      return await handleAgentRename(req, res, agentPatch[1]);
    }
    const agentDel = pathOnly.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "DELETE" && agentDel) {
      return await handleAgentDelete(req, res, agentDel[1]);
    }
    if (req.method === "GET" && pathOnly === "/api/loops") {
      return handleLoopsList(req, res);
    }
    const loopRun = pathOnly.match(/^\/api\/loops\/([a-zA-Z0-9_-]+)\/run$/);
    if (req.method === "POST" && loopRun) {
      return handleLoopRun(req, res, loopRun[1]);
    }
    const loopInputs = pathOnly.match(/^\/api\/loops\/([a-zA-Z0-9_-]+)\/inputs$/);
    if (req.method === "GET" && loopInputs) {
      return handleLoopInputs(req, res, loopInputs[1]);
    }
    if (req.method === "GET" && pathOnly === "/api/briefs") {
      return handleBriefsList(req, res);
    }
    const briefOne = pathOnly.match(/^\/api\/briefs\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "GET" && briefOne) {
      return handleBriefGet(req, res, briefOne[1]);
    }
    if (req.method === "GET" && pathOnly === "/api/standup") {
      return handleStandupFeed(req, res);
    }
    if (req.method === "POST" && pathOnly === "/api/standup/posts") {
      return await handleStandupCreate(req, res);
    }
    if (req.method === "POST" && pathOnly === "/api/standup/read") {
      return await handleStandupRead(req, res);
    }
    if (req.method === "PATCH" && pathOnly === "/api/standup/pins") {
      return await handleStandupPins(req, res);
    }
    const standupOne = pathOnly.match(/^\/api\/standup\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "GET" && standupOne) {
      return handleStandupPostGet(req, res, standupOne[1]);
    }
    if (req.method === "GET" && pathOnly === "/api/jobs") {
      return await handleJobsList(req, res);
    }
    const jobNow = pathOnly.match(/^\/api\/jobs\/([a-f0-9-]+)\/now$/i);
    if (req.method === "POST" && jobNow) {
      return await handleJobSendNow(req, res, jobNow[1]);
    }
    const jobCancel = pathOnly.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/cancel$/i
    );
    if (req.method === "POST" && jobCancel) {
      return await handleJobCancel(req, res, jobCancel[1]);
    }
    const jobFinalize = pathOnly.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/finalize$/i
    );
    if (req.method === "POST" && jobFinalize) {
      return await handleJobFinalize(req, res, jobFinalize[1]);
    }
    const jobMedia = pathOnly.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/media\/(\d+)$/i
    );
    if (req.method === "GET" && jobMedia) {
      return await handleJobMedia(req, res, jobMedia[1], jobMedia[2]);
    }
    const jobStream = pathOnly.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/stream$/i
    );
    if (req.method === "GET" && jobStream) {
      return await handleJobStream(req, res, jobStream[1]);
    }
    const jobMatch = pathOnly.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
    if (req.method === "GET" && jobMatch) {
      return await handleJobGet(req, res, jobMatch[1]);
    }
    if (req.method === "PATCH" && jobMatch) {
      return await handleJobPatch(req, res, jobMatch[1]);
    }
    if (req.method === "DELETE" && jobMatch) {
      return await handleJobDelete(req, res, jobMatch[1]);
    }
    return serveStatic(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
  }
}

const server = http.createServer(onRequest);

function printBanner() {
  const ips = listLanIPv4();
  const ipHint = ips[0] || "<this-mac-ip>";
  const httpsLine = httpsListenInfo
    ? `  https:  https://${HOST}:${httpsListenInfo.port}  (free self-signed — live iPhone mic)
  open:   https://${ipHint}:${httpsListenInfo.port}
           Trust the cert once in Safari, then Add to Home Screen for live mic.`
    : `  https:  (disabled — set openssl available; PHONE_CHAT_TLS=0 to silence)`;
  console.log(`
grok-cli-phone-remote-control
  http:   http://${HOST}:${PORT}
${httpsLine}
  cwd:    ${CWD}
  inbox:  ${INBOX}
  secret: (PHONE_CHAT_SECRET set)

Phone:
  • Chat works on plain http://${ipHint}:${PORT} (free).
  • Live in-page mic (tap → speak → stop): use the free https:// URL above
    (self-signed, no paid Tailscale Serve). Or use the keyboard 🎤 on http.
  • Add to Home Screen after opening the URL you want.

Keep this process running while you chat.
`);
}

server.listen(PORT, HOST, () => {
  if (TLS_DISABLED) {
    printBanner();
    return;
  }
  const material = ensurePhoneTlsMaterial({
    dir: join(homedir(), ".grok", "phone-pwa-tls"),
  });
  if (!material) {
    printBanner();
    return;
  }
  const httpsServer = https.createServer(
    { key: material.key, cert: material.cert },
    onRequest
  );
  httpsServer.on("error", (e) => {
    console.warn("[tls] HTTPS listen failed:", e.message);
    printBanner();
  });
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    httpsListenInfo = { port: HTTPS_PORT };
    printBanner();
  });
});

function startLoopTicker() {
  setInterval(() => {
    void tickDueLoops().catch((e) =>
      console.warn("[loops] tick failed", e?.message || e)
    );
  }, 20_000);
  setTimeout(() => {
    void tickDueLoops().catch(() => {});
  }, 8_000);
}
startLoopTicker();
