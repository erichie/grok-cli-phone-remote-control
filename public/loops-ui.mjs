/**
 * Display helpers for the Loops page.
 */
import { formatFeedTime } from "./standup-ui.mjs";

export function lastRunLabel(iso, nowMs = Date.now()) {
  if (!iso) return "Never ran";
  return `Last ran ${formatFeedTime(iso, nowMs)}`;
}

export function nextRunLabel(iso, nowMs = Date.now()) {
  if (!iso) return "Not scheduled";
  const t = Date.parse(iso);
  if (!t) return "Not scheduled";
  if (t <= nowMs + 45 * 1000) return "Due now";
  return `Next ${formatFeedTime(iso, nowMs)}`;
}
