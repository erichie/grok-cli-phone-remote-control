/**
 * Pure helpers for the phone Activity sidebar (jobs + multi-agent).
 * Shared by the browser UI and unit tests.
 */

/**
 * @typedef {{
 *   id: string,
 *   label?: string,
 *   isMain?: boolean,
 *   alive?: boolean,
 *   agentReady?: boolean,
 *   pid?: number|null,
 *   processing?: boolean,
 *   queueLength?: number,
 *   currentJobId?: string|null,
 *   cwd?: string,
 * }} AgentInfo
 *
 * @typedef {{
 *   id: string,
 *   status: string,
 *   text?: string,
 *   reply?: string,
 *   error?: string|null,
 *   agentId?: string,
 *   agentLabel?: string,
 *   queuePosition?: number,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   tools?: Array<{name?: string, status?: string}>,
 * }} JobInfo
 */

/**
 * @param {AgentInfo[]} agents
 * @param {string} selectedId
 * @returns {string}
 */
/** Host conversation refetch after this long in the background. */
export const SHORT_BACKGROUND_MS = 10_000;

/**
 * True when a resume should pull the Mac transcript.
 * Brief app-switcher hops must not freeze the UI.
 * @param {number|null|undefined} hiddenMs
 */
export function shouldRefreshHostOnResume(hiddenMs) {
  if (hiddenMs == null || !Number.isFinite(Number(hiddenMs))) return true;
  return Number(hiddenMs) >= SHORT_BACKGROUND_MS;
}

export function normalizeSelectedAgentId(agents, selectedId) {
  const list = Array.isArray(agents) ? agents : [];
  if (!selectedId || selectedId === "auto") return selectedId || "main";
  if (selectedId === "default") return "main";
  // Empty roster = not loaded yet. Keep the saved id so resume doesn't snap to Main.
  if (!list.length) return selectedId;
  if (list.some((a) => a.id === selectedId)) return selectedId;
  return "main";
}

/**
 * Short status line for an agent row.
 * @param {AgentInfo} agent
 * @returns {string}
 */
export function agentStatusLine(agent) {
  if (!agent) return "—";
  if (agent.processing || agent.currentJobId) {
    const q = agent.queueLength || 0;
    return q > 0 ? `Working · ${q} queued` : "Working";
  }
  if (agent.queueLength > 0) return `${agent.queueLength} queued`;
  if (agent.alive || agent.agentReady) return "Idle";
  return "Stopped";
}

/**
 * Dot kind for agent live indicator.
 * @param {AgentInfo} agent
 * @returns {'ok'|'busy'|'off'}
 */
export function agentDotKind(agent) {
  if (!agent) return "off";
  if (agent.processing || agent.currentJobId) return "busy";
  if (agent.alive || agent.agentReady) return "ok";
  return "off";
}

/**
 * Preview text for a job row (first meaningful line).
 * @param {JobInfo} job
 * @param {number} [maxLen]
 * @returns {string}
 */
export function jobPreviewText(job, maxLen = 72) {
  if (!job) return "";
  const raw =
    (job.reply && String(job.reply).trim()) ||
    (job.error && `Error: ${job.error}`) ||
    (job.text && String(job.text).trim()) ||
    "";
  const line = raw
    .replace(/\s+/g, " ")
    .replace(/^Error:\s*/i, (m) => m)
    .trim();
  if (!line) {
    if (job.status === "queued") return "Waiting in queue…";
    if (job.status === "running") return "Working…";
    return "—";
  }
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 1) + "…";
}

/**
 * Human job status label.
 * @param {JobInfo} job
 * @returns {string}
 */
export function jobStatusLabel(job) {
  if (!job) return "";
  const st = job.status || "";
  if (st === "queued" && (job.queuePosition || 0) > 0) {
    return `Queued #${job.queuePosition}`;
  }
  if (st === "running") return "Running";
  if (st === "done") return "Done";
  if (st === "error") return "Error";
  if (st === "cancelled") return "Cancelled";
  return st || "—";
}

/**
 * Whether the job can be stopped/finalized from Activity.
 * @param {JobInfo} job
 * @returns {boolean}
 */
export function jobIsActive(job) {
  return !!job && (job.status === "running" || job.status === "queued");
}

/**
 * Partition jobs into active + recent finished for the sidebar.
 * @param {JobInfo[]} jobs
 * @param {{ activeLimit?: number, recentLimit?: number }} [opts]
 * @returns {{ active: JobInfo[], recent: JobInfo[] }}
 */
export function partitionJobs(jobs, opts = {}) {
  const activeLimit = opts.activeLimit ?? 20;
  const recentLimit = opts.recentLimit ?? 12;
  const list = Array.isArray(jobs) ? jobs.slice() : [];
  const active = list
    .filter((j) => jobIsActive(j))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, activeLimit);
  const recent = list
    .filter((j) => !jobIsActive(j))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, recentLimit);
  return { active, recent };
}

/**
 * True when a job has finished its turn (success, error, or cancel).
 * @param {JobInfo|null|undefined} job
 * @returns {boolean}
 */
export function jobIsTerminal(job) {
  const st = job?.status || "";
  return st === "done" || st === "error" || st === "cancelled";
}

/**
 * True when an agent is idle and can take a new user message.
 * @param {AgentInfo|null|undefined} agent
 * @returns {boolean}
 */
export function agentIsReadyForUser(agent) {
  if (!agent) return false;
  if (agent.processing || agent.currentJobId) return false;
  if ((agent.queueLength || 0) > 0) return false;
  return !!(agent.alive || agent.agentReady || agent.isMain);
}

/**
 * Menu badge: only agents that finished a recent turn and are idle
 * (ready for the user). Never inventory of extras or in-flight jobs.
 *
 * @param {JobInfo[]} jobs
 * @param {AgentInfo[]} agents
 * @param {{
 *   selectedAgentId?: string|null,
 *   now?: number,
 *   readyWindowMs?: number,
 * }} [opts]
 * @returns {number}
 */
export function activityBadgeCount(jobs, agents, opts = {}) {
  const now = opts.now ?? Date.now();
  const readyWindowMs = opts.readyWindowMs ?? 30 * 60 * 1000;
  const selectedId = opts.selectedAgentId
    ? String(opts.selectedAgentId)
    : null;

  /** @type {Map<string, number>} agentId → latest finishedAt ms */
  const latestFinished = new Map();
  for (const j of jobs || []) {
    if (!jobIsTerminal(j)) continue;
    const aid = String(j.agentId || "main");
    const t = Date.parse(j.finishedAt || j.updatedAt || 0) || 0;
    if (!t || now - t > readyWindowMs) continue;
    const prev = latestFinished.get(aid) || 0;
    if (t > prev) latestFinished.set(aid, t);
  }

  let count = 0;
  for (const a of agents || []) {
    if (!a?.id) continue;
    // User is already in this chat — no badge nag
    if (selectedId && a.id === selectedId) continue;
    if (!agentIsReadyForUser(a)) continue;
    if (!latestFinished.has(a.id)) continue;
    count++;
  }
  return count;
}

/**
 * Build the agentId value to send with /api/chat.
 * @param {string} selectedId  main | auto | uuid
 * @returns {string}
 */
export function chatAgentIdPayload(selectedId) {
  if (!selectedId || selectedId === "default") return "main";
  return String(selectedId);
}
