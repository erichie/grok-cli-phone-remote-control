/**
 * Local standup feed for the phone PWA.
 * SQLite when `node:sqlite` is available (Node 22+); JSON file fallback otherwise.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const POST_KINDS = ["standup", "update", "alert", "win"];

/** Generic shipped defaults only — personal goals live in a local seed file. */
export const DEFAULT_PINS = {};

const WELCOME_SHORT =
  "This is the daily paper. Loops post here in English. Tap a card for the long version.";

const WELCOME_LONG =
  "Agent loops land as short posts — not chat dumps.\n\n" +
  "Alerts only when something needs you. Jobs and agents have their own pages.";

/**
 * Optional host-local seed (`~/.grok/phone-standup-seed.json`).
 * Never ship personal goals in the public tree — put them in this file.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function readLocalStandupSeed(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object") return {};
    const pins = data.pins && typeof data.pins === "object" ? data.pins : data;
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(pins)) {
      if (v == null || v === "") continue;
      out[k] =
        typeof v === "object" && v.value != null ? String(v.value) : String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function loadDatabaseSync() {
  try {
    // Available on Node 22.5+ (this Mac's launchd agent is 24).
    return createRequireSqlite();
  } catch {
    return null;
  }
}

function createRequireSqlite() {
  // Dynamic so Node 20 test runs still load this module.
  // eslint-disable-next-line no-new-func
  const req = process.getBuiltinModule
    ? process.getBuiltinModule("node:sqlite")
    : null;
  if (req?.DatabaseSync) return req.DatabaseSync;
  throw new Error("no node:sqlite");
}

function normalizePost(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id ?? row.agentId,
    agentName: row.agent_name ?? row.agentName,
    kind: row.kind,
    title: row.title || "",
    bodyShort: row.body_short ?? row.bodyShort,
    bodyLong: (row.body_long ?? row.bodyLong) || "",
    jobId: (row.job_id ?? row.jobId) || null,
    createdAt: row.created_at ?? row.createdAt,
    readAt: (row.read_at ?? row.readAt) || null,
  };
}

function validatePostInput(input) {
  const agentName = String(input?.agentName || "").trim();
  const bodyShort = String(input?.bodyShort || input?.text || "").trim();
  const kind = String(input?.kind || "update").trim().toLowerCase();
  if (!agentName) throw Object.assign(new Error("agentName is required"), { code: "BAD_POST" });
  if (!bodyShort) throw Object.assign(new Error("bodyShort is required"), { code: "BAD_POST" });
  if (!POST_KINDS.includes(kind)) {
    throw Object.assign(new Error(`kind must be one of ${POST_KINDS.join(", ")}`), {
      code: "BAD_POST",
    });
  }
  return {
    id: input.id || randomUUID(),
    agentId: String(input.agentId || "system").trim() || "system",
    agentName,
    kind,
    title: String(input.title || "").trim(),
    bodyShort: bodyShort.slice(0, 560),
    bodyLong: String(input.bodyLong || "").trim(),
    jobId: input.jobId ? String(input.jobId) : null,
    createdAt: input.createdAt || nowIso(),
    readAt: null,
  };
}

class JsonStandup {
  constructor(filePath, seed = {}) {
    this.filePath = filePath;
    this.seed = seed && typeof seed === "object" ? seed : {};
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = { pins: {}, posts: [] };
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (parsed && typeof parsed === "object") {
          this.data.pins = parsed.pins && typeof parsed.pins === "object" ? parsed.pins : {};
          this.data.posts = Array.isArray(parsed.posts) ? parsed.posts : [];
        }
      } catch {
        /* start empty */
      }
    }
    this.#ensureDefaults();
  }

  #save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  #ensureDefaults() {
    let dirty = false;
    for (const [k, v] of Object.entries(this.seed)) {
      if (!this.data.pins[k] && v) {
        this.data.pins[k] = { value: String(v), updatedAt: nowIso() };
        dirty = true;
      }
    }
    if (!this.data.posts.length) {
      this.data.posts.push({
        id: "welcome",
        agentId: "system",
        agentName: "Standup",
        kind: "standup",
        title: "How this feed works",
        bodyShort: WELCOME_SHORT,
        bodyLong: WELCOME_LONG,
        jobId: null,
        createdAt: nowIso(),
        readAt: null,
      });
      dirty = true;
    }
    if (dirty) this.#save();
  }

  getPins() {
    const out = {};
    for (const [k, row] of Object.entries(this.data.pins)) {
      out[k] = typeof row === "object" ? row.value : row;
    }
    return out;
  }

  setPin(key, value) {
    const k = String(key || "").trim();
    if (!k) throw Object.assign(new Error("pin key required"), { code: "BAD_PIN" });
    this.data.pins[k] = { value: String(value ?? ""), updatedAt: nowIso() };
    this.#save();
    return this.getPins();
  }

  listPosts(limit = 80) {
    const n = Math.max(1, Math.min(200, Number(limit) || 80));
    return this.data.posts
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, n)
      .map(normalizePost);
  }

  getPost(id) {
    return normalizePost(this.data.posts.find((p) => p.id === id) || null);
  }

  createPost(input) {
    const post = validatePostInput(input);
    this.data.posts.push(post);
    this.#save();
    return normalizePost(post);
  }

  unreadCount() {
    return this.data.posts.filter((p) => !p.readAt).length;
  }

  markRead(ids) {
    const set = ids === "all" ? null : new Set(ids || []);
    const at = nowIso();
    for (const p of this.data.posts) {
      if (p.readAt) continue;
      if (set && !set.has(p.id)) continue;
      p.readAt = at;
    }
    this.#save();
    return this.unreadCount();
  }
}

class SqliteStandup {
  constructor(DatabaseSync, filePath, seed = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.seed = seed && typeof seed === "object" ? seed : {};
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pins (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        body_short TEXT NOT NULL,
        body_long TEXT,
        job_id TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at DESC);
    `);
    this.#ensureDefaults();
  }

  #ensureDefaults() {
    const now = nowIso();
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO pins (key, value, updated_at) VALUES (?, ?, ?)"
    );
    for (const [k, v] of Object.entries(this.seed)) {
      if (v) ins.run(k, String(v), now);
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM posts").get();
    if (!count?.n) {
      this.db
        .prepare(
          `INSERT INTO posts
            (id, agent_id, agent_name, kind, title, body_short, body_long, job_id, created_at, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "welcome",
          "system",
          "Standup",
          "standup",
          "How this feed works",
          WELCOME_SHORT,
          WELCOME_LONG,
          null,
          now,
          null
        );
    }
  }

  getPins() {
    const rows = this.db.prepare("SELECT key, value FROM pins").all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  setPin(key, value) {
    const k = String(key || "").trim();
    if (!k) throw Object.assign(new Error("pin key required"), { code: "BAD_PIN" });
    this.db
      .prepare(
        "INSERT INTO pins (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(k, String(value ?? ""), nowIso());
    return this.getPins();
  }

  listPosts(limit = 80) {
    const n = Math.max(1, Math.min(200, Number(limit) || 80));
    return this.db
      .prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?")
      .all(n)
      .map(normalizePost);
  }

  getPost(id) {
    return normalizePost(
      this.db.prepare("SELECT * FROM posts WHERE id = ?").get(id) || null
    );
  }

  createPost(input) {
    const post = validatePostInput(input);
    this.db
      .prepare(
        `INSERT INTO posts
          (id, agent_id, agent_name, kind, title, body_short, body_long, job_id, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        post.id,
        post.agentId,
        post.agentName,
        post.kind,
        post.title,
        post.bodyShort,
        post.bodyLong,
        post.jobId,
        post.createdAt,
        null
      );
    return this.getPost(post.id);
  }

  unreadCount() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE read_at IS NULL")
      .get();
    return Number(row?.n || 0);
  }

  markRead(ids) {
    const at = nowIso();
    if (ids === "all") {
      this.db.prepare("UPDATE posts SET read_at = ? WHERE read_at IS NULL").run(at);
    } else {
      const stmt = this.db.prepare(
        "UPDATE posts SET read_at = ? WHERE id = ? AND read_at IS NULL"
      );
      for (const id of ids || []) stmt.run(at, id);
    }
    return this.unreadCount();
  }
}

/**
 * @param {string} filePath  `.db` uses SQLite when possible; otherwise JSON.
 * @param {{ seed?: Record<string, string> }} [opts]
 */
export function openStandup(filePath, opts = {}) {
  const seed = opts.seed && typeof opts.seed === "object" ? opts.seed : {};
  const DatabaseSync = loadDatabaseSync();
  const wantSqlite = filePath.endsWith(".db");
  if (DatabaseSync && wantSqlite) {
    return new SqliteStandup(DatabaseSync, filePath, seed);
  }
  const jsonPath = wantSqlite ? filePath.replace(/\.db$/i, ".json") : filePath;
  return new JsonStandup(jsonPath, seed);
}

export function getFeedPayload(store, limit = 80) {
  return {
    pins: store.getPins(),
    posts: store.listPosts(limit),
    unreadCount: store.unreadCount(),
  };
}
