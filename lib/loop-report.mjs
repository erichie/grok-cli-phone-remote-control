/**
 * Parse a loop agent's final message into a standup card + CoS brief.
 * Build the specialist / synth prompts.
 */
import { briefIsFresh } from "./briefs.mjs";

const KINDS = new Set(["standup", "update", "alert", "win"]);

function clipShort(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 560);
}

function normalizeReport(raw) {
  const kind = String(raw.kind || "update")
    .trim()
    .toLowerCase();
  return {
    title: String(raw.title || "").trim(),
    bodyShort: clipShort(raw.bodyShort || raw.short || raw.text || ""),
    bodyLong: String(raw.bodyLong || raw.brief || raw.body || "").trim(),
    kind: KINDS.has(kind) ? kind : "update",
  };
}

function section(text, name) {
  const re = new RegExp(
    `^${name}:\\s*([\\s\\S]*?)(?=^(?:SHORT|BRIEF|KIND|TITLE):|\\s*$)`,
    "im"
  );
  const m = String(text || "").match(re);
  return m ? m[1].trim() : "";
}

/**
 * @param {string} text
 */
export function parseLoopReport(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { title: "", bodyShort: "", bodyLong: "", kind: "update" };
  }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonCandidates = [];
  if (fence) jsonCandidates.push(fence[1].trim());
  if (raw.startsWith("{")) jsonCandidates.push(raw);
  for (const cand of jsonCandidates) {
    try {
      const o = JSON.parse(cand);
      if (o && (o.bodyShort || o.short || o.bodyLong || o.brief)) {
        const got = normalizeReport(o);
        if (got.bodyShort) return got;
      }
    } catch {
      /* not json */
    }
  }

  const title = section(raw, "TITLE");
  const short = section(raw, "SHORT");
  const brief = section(raw, "BRIEF");
  const kindLine = section(raw, "KIND");
  if (short || brief) {
    const got = normalizeReport({
      title,
      bodyShort: short,
      bodyLong: brief || short,
      kind: kindLine.split(/\s/)[0],
    });
    if (got.bodyShort) return got;
  }

  const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const first = paras[0] || raw;
  return normalizeReport({
    bodyShort: first,
    bodyLong: raw,
    kind: "update",
  });
}

/**
 * @param {object} loop
 * @param {object[]} allLoops
 * @returns {string[]}
 */
export function resolveReads(loop, allLoops) {
  const specified = Array.isArray(loop?.reads)
    ? loop.reads.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const self = String(loop?.id || "");
  if (specified.length) return specified.filter((id) => id && id !== self);
  return (allLoops || [])
    .filter(
      (l) =>
        l &&
        l.id &&
        l.id !== self &&
        l.enabled !== false &&
        l.role !== "synth"
    )
    .map((l) => l.id);
}

/**
 * @param {object} loop
 * @param {object[]} allLoops
 * @param {Record<string, object>} briefs
 * @param {number} [nowMs]
 */
export function gatherSynthInputs(loop, allLoops, briefs = {}, nowMs = Date.now()) {
  const tz = loop?.schedule?.tz || "America/New_York";
  return resolveReads(loop, allLoops).map((id) => {
    const def = (allLoops || []).find((l) => l.id === id);
    const brief = briefs[id] || null;
    const fresh = briefIsFresh(brief, nowMs, tz);
    return {
      loopId: id,
      name: def?.name || id,
      description: def?.description || "",
      present: !!(brief && fresh),
      stale: !!(brief && !fresh),
      brief: brief && fresh ? brief : null,
    };
  });
}

function formatInputBlock(item) {
  if (!item.present) {
    return `### ${item.name}\nNO REPORT TODAY.`;
  }
  const b = item.brief;
  const lines = [
    `### ${item.name}`,
    b.updatedAt ? `updated: ${b.updatedAt}` : "",
    b.title ? `title: ${b.title}` : "",
    b.bodyShort ? `card: ${b.bodyShort}` : "",
    "",
    "BRIEF:",
    b.bodyLong || b.bodyShort || "(empty brief)",
  ];
  return lines.filter((x, i) => x || i === 0).join("\n");
}

const OUTPUT_CONTRACT = `End your reply with exactly this shape (nothing after KIND):

SHORT:
<one English paragraph for the phone feed, max ~400 characters>

BRIEF:
<detailed notes for the Chief of Staff: numbers, what you checked, what you did not check, blockers. Do not invent.>

KIND:
standup|update|alert|win`;

export function buildSpecialistPrompt(loop, pins = {}) {
  const goal = pins.north_star ? `North star: ${pins.north_star}` : "";
  const extra = String(loop.prompt || "").trim();
  return [
    `You are running a scheduled specialist loop: ${loop.name}.`,
    loop.description || "",
    goal,
    extra,
    "Do the work with your tools. Write a short feed card and a longer brief the Chief of Staff will read. The brief should have the actual numbers and sources — not vibes.",
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildSynthPrompt(loop, inputs, pins = {}) {
  const goal = pins.north_star ? `North star: ${pins.north_star}` : "";
  const extra = String(loop.prompt || "").trim();
  const blocks = (inputs || []).map(formatInputBlock).join("\n\n");
  return [
    `You are the Chief of Staff writing the daily standup for the phone paper (${loop.name}).`,
    loop.description || "",
    goal,
    extra ||
      "Write yesterday / today / the highest-leverage move. Quote specialists. Do not re-research.",
    "Use ONLY the specialist briefs below. Do not invent numbers. If a specialist has NO REPORT TODAY, say \"no report\" for that beat — do not fill the gap.",
    OUTPUT_CONTRACT,
    "## Specialist briefs",
    blocks || "(no specialists configured)",
  ]
    .filter(Boolean)
    .join("\n\n");
}
