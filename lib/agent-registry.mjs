/**
 * Multi-agent registry for the phone bridge.
 * Each slot owns a Grok ACP process (spawned via factory) and a serial job queue.
 * Stop/close always kills the Mac process (and best-effort process group).
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {object} AgentSlot
 * @property {string} id
 * @property {string} label
 * @property {string} cwd
 * @property {object} acp  GrokAcp-like instance
 * @property {string[]} jobQueue
 * @property {string|null} currentJobId
 * @property {boolean} queueRunning
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {boolean} isMain
 */

/** Max display name length for agents. */
export const AGENT_LABEL_MAX = 48;

/**
 * Sanitize a user-facing agent label.
 * @param {unknown} raw
 * @param {string} [fallback=""]
 * @returns {string}
 */
export function sanitizeAgentLabel(raw, fallback = "") {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_LABEL_MAX);
  return s || String(fallback || "").trim().slice(0, AGENT_LABEL_MAX);
}

/**
 * @param {{
 *   createAcp: (cwd: string) => object,
 *   defaultCwd: string,
 *   maxAgents?: number,
 * }} opts
 */
export function createAgentRegistry(opts) {
  const { createAcp, defaultCwd, maxAgents = 6 } = opts;
  /** @type {Map<string, AgentSlot>} */
  const slots = new Map();

  function makeSlot({ id, label, cwd, isMain = false }) {
    const now = new Date().toISOString();
    /** @type {AgentSlot} */
    const slot = {
      id,
      label: label || (isMain ? "Main" : `Agent ${id.slice(0, 6)}`),
      cwd: cwd || defaultCwd,
      acp: createAcp(cwd || defaultCwd),
      jobQueue: [],
      currentJobId: null,
      queueRunning: false,
      createdAt: now,
      updatedAt: now,
      isMain: !!isMain,
    };
    slots.set(id, slot);
    return slot;
  }

  // Default long-lived agent (preserves existing single-agent behavior)
  const main = makeSlot({
    id: "main",
    label: "Main",
    cwd: defaultCwd,
    isMain: true,
  });

  function get(id) {
    if (!id || id === "main" || id === "default") return main;
    return slots.get(id) || null;
  }

  function require(id) {
    const s = get(id);
    if (!s) {
      const err = new Error(`agent not found: ${id}`);
      err.code = "AGENT_NOT_FOUND";
      throw err;
    }
    return s;
  }

  function list() {
    return [...slots.values()].map(publicAgent);
  }

  function publicAgent(slot) {
    const pid =
      slot.acp?.proc && !slot.acp.proc.killed ? slot.acp.proc.pid || null : null;
    const termCount =
      typeof slot.acp?.terminals?.terminals?.size === "number"
        ? slot.acp.terminals.terminals.size
        : 0;
    return {
      id: slot.id,
      label: slot.label,
      cwd: slot.cwd,
      isMain: slot.isMain,
      sessionId: slot.acp?.sessionId || null,
      agentReady: !!slot.acp?.sessionId,
      pid,
      alive: !!pid,
      currentJobId: slot.currentJobId,
      queueLength: slot.jobQueue.length,
      processing: slot.queueRunning,
      terminalCount: termCount,
      createdAt: slot.createdAt,
      updatedAt: slot.updatedAt,
    };
  }

  /**
   * Spawn an extra concurrent agent process.
   * @param {{ id?: string, label?: string, cwd?: string, sessionId?: string|null, createdAt?: string }} [params]
   */
  function create(params = {}) {
    if (slots.size >= maxAgents) {
      const err = new Error(
        `max agents reached (${maxAgents}). Stop one before starting another.`
      );
      err.code = "MAX_AGENTS";
      throw err;
    }
    const requested = String(params.id || "").trim();
    const id = requested && requested !== "main" && requested !== "default"
      ? requested
      : randomUUID();
    if (slots.has(id)) {
      const err = new Error(`agent already exists: ${id}`);
      err.code = "AGENT_EXISTS";
      throw err;
    }
    const label =
      sanitizeAgentLabel(params.label, "") || `Agent ${slots.size}`;
    const cwd =
      (params.cwd && String(params.cwd).trim()) || defaultCwd;
    const slot = makeSlot({ id, label, cwd, isMain: false });
    if (params.createdAt) slot.createdAt = String(params.createdAt);
    slot.updatedAt = new Date().toISOString();
    if (params.sessionId && slot.acp) {
      slot.acp.preferredSessionId = String(params.sessionId);
    }
    return publicAgent(slot);
  }

  /**
   * Recreate extra slots from a durable roster (same ids + session ids).
   * Does not start ACP processes — caller warms them after jobs recover.
   * @param {Array<{ id?: string, label?: string, cwd?: string, sessionId?: string|null, createdAt?: string }>} records
   */
  function restore(records = []) {
    const restored = [];
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec?.id || rec.id === "main" || slots.has(rec.id)) continue;
      if (slots.size >= maxAgents) break;
      try {
        restored.push(
          create({
            id: rec.id,
            label: rec.label,
            cwd: rec.cwd || defaultCwd,
            sessionId: rec.sessionId,
            createdAt: rec.createdAt,
          })
        );
      } catch {
        /* skip bad record */
      }
    }
    return restored;
  }

  /**
   * Extra agents only — main lives in phone-conversation.json.
   * @returns {Array<{id: string, label: string, cwd: string, sessionId: string|null, createdAt: string, updatedAt: string}>}
   */
  function snapshotExtras() {
    return [...slots.values()]
      .filter((s) => !s.isMain)
      .map((s) => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        sessionId:
          s.acp?.sessionId || s.acp?.preferredSessionId || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isMain: false,
      }));
  }

  /**
   * Rename an agent (main or extra). Empty label falls back to Main / Agent N.
   * @param {string} id
   * @param {string} label
   */
  function rename(id, label) {
    const slot = require(id);
    const fallback = slot.isMain ? "Main" : `Agent ${slot.id.slice(0, 6)}`;
    const next = sanitizeAgentLabel(label, fallback);
    if (!next) {
      const err = new Error("label is required");
      err.code = "INVALID_LABEL";
      throw err;
    }
    slot.label = next;
    slot.updatedAt = new Date().toISOString();
    return publicAgent(slot);
  }

  /**
   * Hard-stop an agent on the Mac (terminals + SIGTERM/SIGKILL process group).
   * Main agent is reset (restarted) unless removeMain is forced via stopOnly.
   * @param {string} id
   * @param {{ remove?: boolean, stopOnly?: boolean }} [opts]
   */
  async function stop(id, opts = {}) {
    const slot = require(id);
    const remove = !!opts.remove && !slot.isMain;
    const stopOnly = !!opts.stopOnly;

    // Drain this agent's queue bookkeeping (caller should cancel jobs first)
    slot.jobQueue.length = 0;
    slot.currentJobId = null;
    slot.queueRunning = false;
    slot.updatedAt = new Date().toISOString();

    try {
      await slot.acp.cancel?.();
    } catch {
      /* ignore */
    }
    try {
      await slot.acp.stop?.();
    } catch {
      /* ignore */
    }

    if (slot.isMain && !stopOnly && !remove) {
      // Keep main available — restart clean session
      try {
        await slot.acp.reset?.({ fresh: true });
      } catch {
        /* ignore */
      }
    }

    if (remove) {
      slots.delete(slot.id);
      return { ok: true, removed: true, id: slot.id };
    }

    return { ok: true, removed: false, agent: publicAgent(slot) };
  }

  /** Stop every non-main agent hard; reset main. */
  async function stopAllExtras() {
    const ids = [...slots.keys()].filter((id) => id !== "main");
    for (const id of ids) {
      await stop(id, { remove: true });
    }
    await stop("main", { stopOnly: false });
    return { ok: true, removed: ids };
  }

  function touch(id) {
    const s = get(id);
    if (s) s.updatedAt = new Date().toISOString();
  }

  return {
    main,
    get,
    require,
    list,
    create,
    restore,
    snapshotExtras,
    rename,
    stop,
    stopAllExtras,
    touch,
    publicAgent,
    get size() {
      return slots.size;
    },
    get maxAgents() {
      return maxAgents;
    },
  };
}

/**
 * Kill a child process and its process group (Unix).
 * Used by GrokAcp.stop when the agent was spawned with detached process group.
 * @param {import('node:child_process').ChildProcess|null} proc
 * @param {{ graceMs?: number }} [opts]
 */
export async function killProcessTree(proc, opts = {}) {
  if (!proc || proc.killed) return;
  const graceMs = opts.graceMs ?? 400;
  const pid = proc.pid;
  if (!pid) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    return;
  }

  // Prefer process-group kill so shell grandchildren die with the agent
  const killGroup = (sig) => {
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, sig);
        return true;
      }
    } catch {
      /* not a group leader or already dead */
    }
    try {
      proc.kill(sig);
      return true;
    } catch {
      return false;
    }
  };

  killGroup("SIGTERM");
  await new Promise((r) => setTimeout(r, graceMs));
  if (!proc.killed) {
    killGroup("SIGKILL");
  }
}
