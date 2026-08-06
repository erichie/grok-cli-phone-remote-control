/**
 * Shared job stream helpers used by the live ACP bridge and unit tests.
 * Keep these pure(ish): mutate a job object from ACP-style session updates.
 */

const TERMINAL = new Set(["done", "error", "cancelled"]);

/**
 * @param {object} [partial]
 * @returns {object}
 */
export function createJob(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || "test-job",
    status: partial.status || "running",
    text: partial.text || "",
    reply: partial.reply ?? "",
    thought: partial.thought ?? "",
    tools: Array.isArray(partial.tools) ? partial.tools.slice() : [],
    replyImages: Array.isArray(partial.replyImages)
      ? partial.replyImages.slice()
      : [],
    error: partial.error ?? null,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
    startedAt: partial.startedAt || now,
    finishedAt: partial.finishedAt || null,
    sessionId: partial.sessionId || null,
    userFinalized: partial.userFinalized || false,
    attempts: partial.attempts || 0,
    ...partial,
  };
}

export function isTerminalJobStatus(status) {
  return TERMINAL.has(status);
}

/**
 * Apply one ACP `session/update` payload (the inner `update` object) to a job.
 * This is the same path the live agent uses for progressive stream ingest.
 *
 * @param {object} job
 * @param {object} update  ACP SessionUpdate-like object
 * @returns {{ progressed: boolean, kind: string|null, paths: string[] }}
 *   progressed: true for message/tool activity (resets hang idle timer)
 *   paths: absolute image paths found in text (caller may validate/add)
 */
export function applySessionUpdate(job, update) {
  if (!job || !update || typeof update !== "object") {
    return { progressed: false, kind: null, paths: [] };
  }
  if (job.reply == null) job.reply = "";
  if (job.thought == null) job.thought = "";
  if (!Array.isArray(job.tools)) job.tools = [];

  const u = update;
  const kind = u.sessionUpdate || u.type || null;
  job.updatedAt = new Date().toISOString();
  const paths = [];

  if (kind === "agent_message_chunk") {
    const content = u.content;
    if (content?.type === "image") {
      // caller handles image content blocks if needed
      return { progressed: true, kind, paths, imageContent: content };
    }
    const t = content?.text ?? u.text ?? "";
    if (t) {
      job.reply = (job.reply || "") + t;
      for (const p of extractImagePathsFromText(t)) paths.push(p);
    }
    return { progressed: true, kind, paths };
  }

  if (kind === "agent_thought_chunk") {
    // Thoughts alone do NOT count as hang-timer progress (high-effort can stream forever).
    const t = u.content?.text ?? u.text ?? "";
    if (t) {
      job.thought = (job.thought || "") + t;
      if (job.thought.length > 4000) {
        job.thought = job.thought.slice(-4000);
      }
    }
    return { progressed: false, kind, paths };
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const name =
      u._meta?.["x.ai/tool"]?.name ||
      u.title ||
      u.tool ||
      u.kind ||
      "tool";
    const status =
      u.status || (kind === "tool_call" ? "running" : "update");
    const last = job.tools[job.tools.length - 1];
    if (last && last.name === name) last.status = status;
    else job.tools.push({ name, status, at: job.updatedAt });
    if (job.tools.length > 40) job.tools = job.tools.slice(-40);
    return { progressed: true, kind, paths, toolUpdate: u };
  }

  // Unknown update kinds: still stamp updatedAt so SSE can refresh
  return { progressed: false, kind, paths };
}

/**
 * Apply a synthetic "done" event (session/prompt result).
 * @param {object} job
 * @param {object|string|null} result
 */
export function applyPromptDone(job, result) {
  if (!job) return;
  job.updatedAt = new Date().toISOString();
  const textOut =
    (result && typeof result === "object" && result.text) ||
    (typeof result === "string" ? result : "") ||
    "";
  if (!job.reply && textOut) job.reply = textOut;
}

/**
 * Force a non-terminal job into done/error so the phone never stays "running".
 * Used by idle/max hang recovery and unit tests of the same path.
 *
 * @param {object} job
 * @param {{ reason?: string, status?: 'done'|'error', note?: string }} [opts]
 * @returns {object} job
 */
export function forceTerminalizeJob(job, opts = {}) {
  if (!job) return job;
  if (isTerminalJobStatus(job.status)) return job;

  const reason = opts.reason || "hang recovery";
  const partial = String(job.reply || "").trim();
  const prefer =
    opts.status ||
    (partial ? "done" : "error");

  job.status = prefer;
  job.error =
    prefer === "error"
      ? job.error || reason
      : partial
        ? null
        : reason;
  if (!partial) {
    job.reply =
      `Error: ${reason}\n\n_(Send the message again.)_`;
  } else if (opts.note !== false) {
    const note =
      typeof opts.note === "string"
        ? opts.note
        : `_(Stopped early: ${reason}. This is everything received so far.)_`;
    if (!job.reply.includes("Stopped early") && !job.reply.includes("Timed out")) {
      job.reply = job.reply.trimEnd() + "\n\n" + note;
    }
  }
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  return job;
}

/**
 * Lightweight hang watchdog state used by tests and optionally by runAgentTurn.
 */
export function createHangWatch({
  idleMs = 4 * 60 * 1000,
  maxMs = 45 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const startMs = now();
  let lastProgressMs = startMs;
  return {
    markProgress() {
      lastProgressMs = now();
    },
    /** @returns {'idle'|'max'|null} */
    check() {
      const t = now();
      if (t - startMs >= maxMs) return "max";
      if (t - lastProgressMs >= idleMs) return "idle";
      return null;
    },
    get lastProgressMs() {
      return lastProgressMs;
    },
    get startMs() {
      return startMs;
    },
  };
}

/** Extract absolute image paths from free text (best-effort). */
export function extractImagePathsFromText(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const re =
    /(\/(?:Users|Volumes|home|tmp|var)[^\s`'"<>\]\)]+\.(?:png|jpe?g|webp|gif|tiff?))/gi;
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}
