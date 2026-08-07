/**
 * Thinking-block markup for in-progress bot turns.
 * Used by public/app.js setThinking — unit tests import this same module.
 */

/** @param {string} s */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build inner HTML for a thinking element.
 * @param {{ phase?: string, tools?: string, thought?: string }} opts
 * @returns {string}
 */
/**
 * Strip trailing "..." / "…" so we don't double up with animated dots.
 * @param {string} phase
 */
export function stripTrailingEllipsis(phase) {
  return String(phase || "")
    .replace(/(?:\u2026|\.{2,})\s*$/u, "")
    .trimEnd();
}

export function buildThinkingHtml(opts = {}) {
  // Animated dots are the ellipsis — don't also put … on the label
  const phase = stripTrailingEllipsis(opts.phase || "Working") || "Working";
  const tools = (opts.tools || "").trim();
  const thought = (opts.thought || "").trim();
  const parts = [];

  // Breathing gradient label + animated dots (CSS classes are the animation hooks)
  parts.push(
    `<div class="think-row">` +
      `<span class="think-label think-breathe">${escapeHtml(phase)}</span>` +
      `<span class="think-dots" aria-hidden="true">` +
      `<span class="think-dot"></span>` +
      `<span class="think-dot"></span>` +
      `<span class="think-dot"></span>` +
      `</span>` +
      `</div>`
  );

  if (tools) {
    parts.push(
      `<div class="think-tools">${escapeHtml(tools)}</div>`
    );
  }
  if (thought) {
    const clip =
      thought.length > 900 ? "…" + thought.slice(-900) : thought;
    parts.push(
      `<div class="think-body">${escapeHtml(clip)}</div>`
    );
  }
  return parts.join("");
}

/**
 * Whether header recovery controls should show for a job status.
 * @param {string|undefined|null} jobStatus
 */
export function shouldShowJobRecovery(jobStatus) {
  return (
    !!jobStatus &&
    jobStatus !== "done" &&
    jobStatus !== "error" &&
    jobStatus !== "cancelled"
  );
}

/**
 * Pure state transition for header Get result / Stop & show visibility.
 * Same rules as syncHeaderJobActions in app.js (shipped recovery UI).
 *
 * @param {string|null|undefined} currentHeaderJobId job currently shown in header
 * @param {string|null|undefined} jobId job that just updated (null = clear all)
 * @param {string|null|undefined} jobStatus
 * @returns {{ visible: boolean, activeJobId: string|null }}
 */
export function nextHeaderJobVisibility(
  currentHeaderJobId,
  jobId,
  jobStatus
) {
  if (!jobId || !shouldShowJobRecovery(jobStatus)) {
    // Hide when clearing all, or when the active header job ends/errors/resets
    if (
      !jobId ||
      currentHeaderJobId === jobId ||
      !currentHeaderJobId
    ) {
      return { visible: false, activeJobId: null };
    }
    // A different job finished — keep header on the still-active one
    return {
      visible: true,
      activeJobId: currentHeaderJobId,
    };
  }
  return { visible: true, activeJobId: jobId };
}
