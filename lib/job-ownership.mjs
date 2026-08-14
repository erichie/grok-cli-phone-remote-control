/**
 * Job ownership / sealing rules for cancel, finalize, and hang recovery.
 * Once sealed, runJob / stream / headless must not overwrite the phone result.
 */
import { isTerminalJobStatus } from "./job-stream.mjs";

/**
 * True when the phone (or recovery) owns the final job status/reply.
 * @param {object|null|undefined} job
 */
export function isJobSealed(job) {
  if (!job) return true;
  if (job.userFinalized) return true;
  if (isTerminalJobStatus(job.status)) return true;
  return false;
}

/**
 * Mark the job as owned by the phone / recovery so later agent paths bail out.
 * @param {object} job
 * @param {{
 *   status: 'done'|'error'|'cancelled',
 *   error?: string|null,
 *   reply?: string,
 * }} opts
 */
/**
 * True when the job is still waiting (not the in-flight current job).
 * Only then may the phone edit or delete the queued text.
 * @param {object|null|undefined} job
 * @param {string|null|undefined} currentJobId
 */
export function isQueuedWaitingJob(job, currentJobId) {
  if (!job?.id) return false;
  if (job.status !== "queued") return false;
  if (job.userFinalized) return false;
  if (isTerminalJobStatus(job.status)) return false;
  if (currentJobId && job.id === currentJobId) return false;
  return true;
}

/**
 * Replace the user text on a queued job. Throws EMPTY_TEXT if blank.
 * @param {object} job
 * @param {unknown} text
 */
/**
 * Move `id` to the front of a queue (in place). False if it is not in the list.
 * @param {string[]} queue
 * @param {string} id
 */
export function promoteQueuedJob(queue, id) {
  if (!Array.isArray(queue) || !id) return false;
  const idx = queue.indexOf(id);
  if (idx < 0) return false;
  if (idx > 0) {
    queue.splice(idx, 1);
    queue.unshift(id);
  }
  return true;
}

export function applyQueuedJobText(job, text) {
  const next = String(text ?? "").trim();
  if (!next) {
    throw Object.assign(new Error("text is required"), { code: "EMPTY_TEXT" });
  }
  job.text = next;
  job.updatedAt = new Date().toISOString();
  return job;
}

export function sealJob(job, opts) {
  if (!job) return job;
  job.userFinalized = true;
  job.status = opts.status;
  if (opts.error !== undefined) job.error = opts.error;
  if (opts.reply !== undefined) job.reply = opts.reply;
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  return job;
}

/**
 * Whether a short user message is a bare confirmation that needs prior-turn context.
 * @param {string} text
 */
export function isShortFollowUp(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 96) return false;
  // multi-sentence / substantive questions keep full agent turn as-is
  if (/[?]/.test(t) && t.length > 24) return false;
  return /^(yes|yep|yeah|yup|ok|okay|sure|please|pls|do it|go ahead|go for it|sounds good|lgtm|ship it|yes please|yes,?\s*please|do that|that works|continue|proceed)\b/i.test(
    t
  );
}

/**
 * Build a system context block from recent finished jobs so cold ACP sessions
 * still understand "yes please" after a restart or agent reset.
 * @param {Array<object>} recentJobs newest-first preferred
 * @param {string} currentJobId
 * @param {number} [limit]
 */
export function buildRecentContextBlock(recentJobs, currentJobId, limit = 2) {
  const lines = [];
  let n = 0;
  for (const j of recentJobs || []) {
    if (!j || j.id === currentJobId) continue;
    if (!isTerminalJobStatus(j.status) && j.status !== "done") continue;
    if (j.status === "cancelled" && !(j.reply || "").trim()) continue;
    const q = String(j.text || "").trim();
    const a = String(j.reply || "").trim();
    if (!q && !a) continue;
    n += 1;
    lines.push(`### Prior turn ${n}`);
    if (q) lines.push(`User: ${q.slice(0, 600)}`);
    if (a) {
      // strip our own stop markers for cleaner context
      const clean = a
        .replace(/\n*_\(Stopped early[^)]*\)_\s*$/i, "")
        .replace(/\n*_\(Stopped —[^)]*\)_\s*$/i, "")
        .slice(0, 1800);
      lines.push(`Assistant: ${clean}`);
    }
    lines.push("");
    if (n >= limit) break;
  }
  if (!lines.length) return "";
  return [
    "[System: conversation context from recent phone turns. The long-lived agent session may have been reset — use this to interpret short follow-ups like \"yes\" / \"do it\".]",
    "",
    ...lines,
    "Respond to the user's latest message in light of the prior turn(s) above.",
  ].join("\n");
}
