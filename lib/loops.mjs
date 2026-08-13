/**
 * Host-local loop catalog for the phone PWA.
 * Definitions live in a JSON file the user copies from the example;
 * last-run timestamps live in a sidecar state file.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

/**
 * @param {string} filePath
 * @returns {{ loops: object[], source: 'local'|'missing' }}
 */
export function readLocalLoops(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { loops: [], source: "missing" };
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const raw = Array.isArray(data)
      ? data
      : Array.isArray(data?.loops)
        ? data.loops
        : [];
    const loops = raw.map(normalizeLoopDef).filter(Boolean);
    return { loops, source: "local" };
  } catch {
    return { loops: [], source: "missing" };
  }
}

function normalizeLoopDef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  if (!id || !name) return null;
  const schedule =
    raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {};
  const role = String(raw.role || "specialist").trim().toLowerCase();
  const reads = Array.isArray(raw.reads)
    ? raw.reads.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  return {
    id,
    name,
    description: String(raw.description || "").trim(),
    enabled: raw.enabled !== false,
    role: role === "synth" ? "synth" : "specialist",
    reads,
    prompt: String(raw.prompt || "").trim(),
    kind: String(raw.kind || "").trim().toLowerCase() || null,
    schedule: {
      kind: String(schedule.kind || "weekdays"),
      time: schedule.time || null,
      start: schedule.start || null,
      end: schedule.end || null,
      days: schedule.days || "weekdays",
      tz: schedule.tz || "America/New_York",
    },
  };
}

export function readLoopState(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function writeLoopState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n");
}

function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    weekday: map.weekday,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function parseHm(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function isAllowedDay(weekday, days) {
  if (days === "daily" || days === "every") return true;
  return WEEKDAYS.has(weekday);
}

/**
 * Next fire time as ISO, or null if the schedule cannot be parsed.
 * @param {object} schedule
 * @param {number} [nowMs]
 */
export function nextRunAt(schedule, nowMs = Date.now()) {
  if (!schedule) return null;
  const tz = schedule.tz || "America/New_York";
  const days = schedule.days || (schedule.kind === "daily" ? "daily" : "weekdays");
  const hourly = schedule.kind === "hourly";
  const start = hourly ? parseHm(schedule.start || "09:00") : parseHm(schedule.time || "08:00");
  const end = hourly ? parseHm(schedule.end || "18:00") : start;
  if (!start || !end) return null;

  const startMin = Math.ceil(nowMs / 60000) * 60000;
  const horizon = startMin + 16 * 24 * 60 * 60 * 1000;
  for (let ms = startMin; ms <= horizon; ms += 60000) {
    const p = zonedParts(new Date(ms), tz);
    if (schedule.kind !== "daily" && !isAllowedDay(p.weekday, days)) continue;
    const mins = p.hour * 60 + p.minute;
    if (hourly) {
      const a = start.hour * 60 + start.minute;
      const b = end.hour * 60 + end.minute;
      if (mins < a || mins > b) continue;
      if (p.minute !== start.minute) continue;
      return new Date(ms).toISOString();
    }
    if (p.hour === start.hour && p.minute === start.minute) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}

/**
 * True when this schedule has a fire in the last `slackMs` that has not run yet.
 * Missed windows (Mac asleep) wait for the next slot — no catch-up stampede.
 */
export function isLoopDue(schedule, lastRunAt, nowMs = Date.now(), slackMs = 90_000) {
  if (!schedule) return false;
  const slot = nextRunAt(schedule, nowMs - slackMs);
  if (!slot) return false;
  const t = Date.parse(slot);
  if (!Number.isFinite(t)) return false;
  if (t > nowMs + 15_000) return false;
  if (nowMs - t > slackMs) return false;
  if (lastRunAt && Date.parse(lastRunAt) >= t - 1000) return false;
  return true;
}

/**
 * Human schedule line from the spec.
 */
export function scheduleLabel(schedule) {
  if (!schedule) return "Unscheduled";
  const tz = shortTz(schedule.tz);
  if (schedule.kind === "hourly") {
    const start = schedule.start || "09:00";
    const end = schedule.end || "18:00";
    const days = schedule.days === "daily" ? "daily" : "weekdays";
    return `${days} hourly ${start}–${end} ${tz}`.trim();
  }
  const time = schedule.time || "08:00";
  if (schedule.kind === "daily") return `daily ${time} ${tz}`.trim();
  return `weekdays ${time} ${tz}`.trim();
}

function shortTz(tz) {
  if (!tz) return "";
  if (tz === "America/New_York") return "ET";
  if (tz === "America/Chicago") return "CT";
  if (tz === "America/Denver") return "MT";
  if (tz === "America/Los_Angeles") return "PT";
  if (tz === "UTC") return "UTC";
  return tz;
}

/**
 * @param {object[]} defs
 * @param {Record<string, object>} state
 * @param {number} [nowMs]
 */
export function listLoops(defs, state = {}, nowMs = Date.now()) {
  return (defs || []).map((loop) => {
    const st = state[loop.id] || {};
    return {
      ...loop,
      scheduleLabel: scheduleLabel(loop.schedule),
      nextRunAt: loop.enabled ? nextRunAt(loop.schedule, nowMs) : null,
      lastRunAt: st.lastRunAt || null,
      lastStatus: st.lastStatus || null,
      lastSummary: st.lastSummary || null,
    };
  });
}

export function recordLoopRun(statePath, id, opts = {}) {
  const state = readLoopState(statePath);
  state[id] = {
    lastRunAt: opts.at || new Date().toISOString(),
    lastStatus: opts.status || "ok",
    lastSummary: opts.summary || "",
  };
  writeLoopState(statePath, state);
  return state[id];
}
