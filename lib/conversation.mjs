/**
 * Durable phone conversation on the Mac.
 * Survives bridge restarts and agent process replacement so reconnect
 * always reloads prior text and can resume ACP when session/load works.
 */
import { readFile, writeFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isTerminalJobStatus } from "./job-stream.mjs";

/**
 * @typedef {{
 *   role: 'user'|'assistant',
 *   text: string,
 *   jobId?: string,
 *   jobStatus?: string,
 *   at: string,
 *   tools?: string,
 * }} ConversationTurn
 *
 * @typedef {{
 *   conversationId: string,
 *   acpSessionId: string|null,
 *   turns: ConversationTurn[],
 *   clearedAt: string|null,
 *   updatedAt: string,
 *   createdAt: string,
 * }} ConversationState
 */

export const MAX_TURNS = 120;

/**
 * Durable host transcript is the **main** agent only.
 * Extra concurrent agents keep their own process + phone-local history.
 * @param {string|null|undefined} agentId
 */
export function isMainAgentId(agentId) {
  const id = String(agentId || "main").trim() || "main";
  return id === "main" || id === "default" || id === "auto";
}

/**
 * @param {object|null|undefined} job
 */
export function jobBelongsToMainConversation(job) {
  return isMainAgentId(job?.agentId);
}

/**
 * @param {string} [conversationId]
 * @returns {ConversationState}
 */
export function emptyConversation(conversationId) {
  const now = new Date().toISOString();
  return {
    conversationId: conversationId || randomUUID(),
    acpSessionId: null,
    turns: [],
    clearedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * New conversation epoch (/clear, /new, Reset).
 * Drops turns and sets clearedAt so old phone-jobs are not re-appended.
 * @param {ConversationState} [prev]
 * @returns {ConversationState}
 */
export function startFreshConversation(prev) {
  const now = new Date().toISOString();
  return {
    conversationId: randomUUID(),
    acpSessionId: null,
    turns: [],
    clearedAt: now,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
}

/**
 * @param {string} storePath
 * @returns {Promise<ConversationState>}
 */
export async function loadConversation(storePath) {
  try {
    const raw = await readFile(storePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return emptyConversation();
    return {
      conversationId: data.conversationId || randomUUID(),
      acpSessionId:
        typeof data.acpSessionId === "string" ? data.acpSessionId : null,
      turns: Array.isArray(data.turns) ? data.turns : [],
      clearedAt:
        typeof data.clearedAt === "string" ? data.clearedAt : null,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  } catch {
    return emptyConversation();
  }
}

/**
 * @param {string} storePath
 * @param {ConversationState} state
 */
export async function saveConversation(storePath, state) {
  const dir = join(storePath, "..");
  await mkdir(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  if (state.turns.length > MAX_TURNS) {
    state.turns = state.turns.slice(-MAX_TURNS);
  }
  const tmp = storePath + `.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, storePath);
  return state;
}

/**
 * Upsert user + assistant turns from a job snapshot.
 * @param {ConversationState} state
 * @param {object} job
 * @returns {ConversationState}
 */
export function upsertJobInConversation(state, job) {
  if (!state || !job?.id) return state;
  const at = job.updatedAt || job.finishedAt || job.createdAt || new Date().toISOString();
  const userText = String(job.text || "").trim();
  const reply = String(job.reply || "").trim();
  const toolsLine = Array.isArray(job.tools)
    ? job.tools.map((t) => `${t.name} (${t.status})`).join(" · ")
    : "";

  // User turn
  if (userText) {
    const ui = state.turns.findIndex(
      (t) => t.role === "user" && t.jobId === job.id
    );
    const userTurn = {
      role: "user",
      text: userText,
      jobId: job.id,
      at: job.createdAt || at,
    };
    if (ui >= 0) state.turns[ui] = { ...state.turns[ui], ...userTurn };
    else state.turns.push(userTurn);
  }

  // Assistant turn (even partial while running — so reconnect shows text)
  const ai = state.turns.findIndex(
    (t) => t.role === "assistant" && t.jobId === job.id
  );
  const assistantTurn = {
    role: "assistant",
    text: reply,
    jobId: job.id,
    jobStatus: job.status,
    at,
    tools: toolsLine || undefined,
  };
  if (ai >= 0) {
    // Prefer longer reply (never shrink on partial races unless sealed terminal empty)
    const prev = state.turns[ai].text || "";
    if (reply.length >= prev.length || isTerminalJobStatus(job.status)) {
      state.turns[ai] = { ...state.turns[ai], ...assistantTurn };
    } else {
      state.turns[ai] = {
        ...state.turns[ai],
        jobStatus: job.status,
        tools: toolsLine || state.turns[ai].tools,
        at,
      };
    }
  } else if (reply || job.status === "running" || job.status === "queued") {
    state.turns.push(assistantTurn);
  }

  if (job.sessionId && typeof job.sessionId === "string") {
    state.acpSessionId = job.sessionId;
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

/**
 * Build ordered phone-UI messages from conversation turns.
 * @param {ConversationState} state
 * @param {number} [limit]
 */
export function conversationToMessages(state, limit = 80) {
  const turns = (state?.turns || []).slice(-limit);
  return turns.map((t) => ({
    role: t.role === "user" ? "user" : "bot",
    text: t.text || "",
    jobId: t.jobId,
    jobStatus: t.jobStatus,
    tools: t.tools,
  }));
}

/**
 * Rebuild conversation turns from durable job JSON files (bridge restart bootstrap).
 * @param {string} jobsDir
 * @param {ConversationState} [base]
 * @returns {Promise<ConversationState>}
 */
/**
 * @param {object} job
 * @param {string|null|undefined} clearedAt ISO timestamp
 */
export function jobIsAfterClear(job, clearedAt) {
  if (!clearedAt) return true;
  const t =
    Date.parse(job?.createdAt || job?.startedAt || job?.updatedAt || 0) || 0;
  const cut = Date.parse(clearedAt) || 0;
  // Strictly after clear — jobs at the clear moment are excluded
  return t > cut;
}

export async function rebuildConversationFromJobs(jobsDir, base) {
  const state = base || emptyConversation();
  let names = [];
  try {
    names = await readdir(jobsDir);
  } catch {
    return state;
  }
  /** @type {{ m: number, job: object }[]} */
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const p = join(jobsDir, name);
      const st = await stat(p);
      const job = JSON.parse(await readFile(p, "utf8"));
      if (job?.id) rows.push({ m: st.mtimeMs, job });
    } catch {
      /* ignore */
    }
  }
  rows.sort((a, b) => a.m - b.m);
  /** @type {Set<string>} */
  const extraJobIds = new Set();
  for (const { job } of rows) {
    if (!jobIsAfterClear(job, state.clearedAt)) continue;
    if (!jobBelongsToMainConversation(job)) {
      extraJobIds.add(job.id);
      continue;
    }
    upsertJobInConversation(state, job);
  }
  // Heal transcripts that previously imported extra-agent jobs
  if (extraJobIds.size && Array.isArray(state.turns)) {
    state.turns = state.turns.filter(
      (t) => !t?.jobId || !extraJobIds.has(t.jobId)
    );
  }
  return state;
}

/**
 * Prompt context from durable transcript (when ACP session is new / unloaded).
 * @param {ConversationTurn[]} turns
 * @param {string} [excludeJobId]
 * @param {number} [maxTurns]
 */
export function buildTranscriptPromptContext(turns, excludeJobId, maxTurns = 8) {
  const lines = [];
  const list = (turns || []).filter((t) => t.jobId !== excludeJobId);
  const slice = list.slice(-maxTurns);
  if (!slice.length) return "";
  lines.push(
    "[System: durable phone conversation transcript. The ACP agent process may have restarted — continue this same conversation. Prior turns:]"
  );
  lines.push("");
  for (const t of slice) {
    const role = t.role === "user" ? "User" : "Assistant";
    const text = String(t.text || "")
      .replace(/\n*_\(Stopped early[^)]*\)_\s*$/i, "")
      .replace(/\n*_\(Interrupted[^)]*\)_\s*$/i, "")
      .trim();
    if (!text) continue;
    lines.push(`${role}: ${text.slice(0, 1500)}`);
    lines.push("");
  }
  lines.push("Continue from here. The user's new message follows.");
  return lines.join("\n");
}

/**
 * Simulate bridge restart seam used in tests: drop in-memory agent handle fields
 * but keep durable conversation file contents.
 * @param {{ acpSessionId: string|null, conversationId: string }} live
 * @param {ConversationState} disk
 */
export function restoreAfterRestart(live, disk) {
  return {
    conversationId: disk.conversationId || live.conversationId,
    acpSessionId: disk.acpSessionId || null,
    turns: Array.isArray(disk.turns) ? disk.turns.slice() : [],
    priorAssistantTexts: (disk.turns || [])
      .filter((t) => t.role === "assistant" && (t.text || "").trim())
      .map((t) => t.text),
  };
}
