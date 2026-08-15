/**
 * Durable extra-agent roster (host-only, ~/.grok/phone-agents.json).
 * Main stays in phone-conversation.json. Never commit this file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeAgentLabel } from "./agent-registry.mjs";

export const AGENT_ROSTER_VERSION = 1;

/**
 * @typedef {object} PersistedAgent
 * @property {string} id
 * @property {string} label
 * @property {string} cwd
 * @property {string|null} sessionId
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 */

/**
 * @param {unknown} raw
 * @returns {PersistedAgent|null}
 */
export function normalizePersistedAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const id = String(rec.id || "").trim();
  if (!id || id === "main" || id === "default" || id === "loops") return null;
  const label = sanitizeAgentLabel(rec.label, `Agent ${id.slice(0, 8)}`);
  const cwd = typeof rec.cwd === "string" ? rec.cwd.trim() : "";
  const sessionId =
    typeof rec.sessionId === "string" && rec.sessionId.trim()
      ? rec.sessionId.trim()
      : null;
  const createdAt =
    typeof rec.createdAt === "string" && rec.createdAt ? rec.createdAt : null;
  const updatedAt =
    typeof rec.updatedAt === "string" && rec.updatedAt ? rec.updatedAt : null;
  return { id, label, cwd, sessionId, createdAt, updatedAt };
}

/**
 * @param {unknown[]} agents
 * @returns {PersistedAgent[]}
 */
export function serializeAgentRoster(agents) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(agents) ? agents : []) {
    const rec = normalizePersistedAgent({
      id: raw?.id,
      label: raw?.label,
      cwd: raw?.cwd,
      sessionId: raw?.sessionId || raw?.acp?.sessionId || raw?.acp?.preferredSessionId,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
      isMain: raw?.isMain,
    });
    if (!rec || seen.has(rec.id) || raw?.isMain) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  return out;
}

/**
 * @param {unknown} data
 * @returns {PersistedAgent[]}
 */
export function parseAgentRoster(data) {
  if (!data || typeof data !== "object") return [];
  const rec = /** @type {Record<string, unknown>} */ (data);
  const list = Array.isArray(rec.agents) ? rec.agents : Array.isArray(data) ? data : [];
  return serializeAgentRoster(list);
}

/**
 * @param {string} filePath
 * @returns {Promise<PersistedAgent[]>}
 */
export async function loadAgentRoster(filePath) {
  if (!filePath) return [];
  try {
    const raw = await readFile(filePath, "utf8");
    return parseAgentRoster(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * @param {string} filePath
 * @param {unknown[]} agents
 */
export async function saveAgentRoster(filePath, agents) {
  if (!filePath) return;
  const list = serializeAgentRoster(agents);
  const body = JSON.stringify(
    {
      version: AGENT_ROSTER_VERSION,
      updatedAt: new Date().toISOString(),
      agents: list,
    },
    null,
    2
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, body + "\n", "utf8");
}
