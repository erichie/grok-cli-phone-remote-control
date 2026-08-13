/**
 * Latest specialist brief per loop. Host-only JSON.
 * The standup card is the short; this is what a synth / CoS loop reads.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

export function readAllBriefs(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function readBrief(filePath, loopId) {
  const id = String(loopId || "").trim();
  if (!id) return null;
  return readAllBriefs(filePath)[id] || null;
}

/**
 * @param {string} filePath
 * @param {object} input
 */
export function upsertBrief(filePath, input) {
  const loopId = String(input?.loopId || "").trim();
  if (!loopId) {
    throw Object.assign(new Error("loopId is required"), { code: "BAD_BRIEF" });
  }
  const all = readAllBriefs(filePath);
  const prev = all[loopId] || {};
  const brief = {
    loopId,
    agentName: String(input.agentName || prev.agentName || loopId).trim(),
    title: String(input.title ?? prev.title ?? "").trim(),
    bodyShort: String(input.bodyShort ?? input.short ?? prev.bodyShort ?? "").trim(),
    bodyLong: String(input.bodyLong ?? input.brief ?? prev.bodyLong ?? "").trim(),
    kind: String(input.kind || prev.kind || "update"),
    data:
      input.data && typeof input.data === "object" && !Array.isArray(input.data)
        ? input.data
        : prev.data || null,
    postId: input.postId || prev.postId || null,
    jobId: input.jobId || prev.jobId || null,
    updatedAt: input.updatedAt || nowIso(),
  };
  all[loopId] = brief;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(all, null, 2) + "\n");
  return brief;
}

function zonedYmd(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/**
 * True when the brief is from today in `tz`, or newer than 20 hours.
 */
export function briefIsFresh(brief, nowMs = Date.now(), tz = "America/New_York") {
  if (!brief?.updatedAt) return false;
  const t = Date.parse(brief.updatedAt);
  if (!Number.isFinite(t)) return false;
  if (nowMs - t <= 20 * 60 * 60 * 1000) return true;
  return zonedYmd(new Date(t), tz) === zonedYmd(new Date(nowMs), tz);
}
