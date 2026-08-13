/**
 * Pure helpers for the phone standup feed.
 */

export function formatFeedTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || 0);
  if (!t) return "";
  const diff = nowMs - t;
  if (diff < 45 * 1000) return "now";
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))}m`;
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.max(1, Math.round(diff / 3600000))}h`;
  }
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function kindLabel(kind) {
  const k = String(kind || "update");
  if (k === "standup") return "Standup";
  if (k === "alert") return "Alert";
  if (k === "win") return "Win";
  return "Update";
}

export function combineMenuBadge(jobReadyCount, standupUnread) {
  const a = Number(jobReadyCount) || 0;
  const b = Number(standupUnread) || 0;
  return a + b;
}

/**
 * Public first-principles algorithm (widely attributed to Musk).
 * Personal goals / applications belong in the local standup seed, not here.
 */
export const FIRST_PRINCIPLES_STEPS = [
  {
    n: "1",
    title: "Question every requirement",
    body: "Each requirement should come from a person, not a department. Ask why it exists, who needs it, and what happens if it is gone.",
  },
  {
    n: "2",
    title: "Delete any part or process you can",
    body: "If you do not delete too much, you are not deleting enough. You can always add back what turns out to be necessary.",
  },
  {
    n: "3",
    title: "Simplify and optimize",
    body: "Only after deletion. Do not optimize something that should not exist.",
  },
  {
    n: "4",
    title: "Accelerate cycle time",
    body: "Go faster once the steps are the right steps. Speeding up waste still wastes.",
  },
  {
    n: "5",
    title: "Automate",
    body: "Last. Automating a bad or extra step cements the mistake.",
  },
];
