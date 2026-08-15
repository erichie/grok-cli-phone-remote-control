/**
 * Durable extra-agent roster (host-only file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAgentRoster,
  serializeAgentRoster,
  loadAgentRoster,
  saveAgentRoster,
} from "../lib/agents-store.mjs";

test("serializeAgentRoster drops main and loops", () => {
  const list = serializeAgentRoster([
    { id: "main", label: "Main", isMain: true, sessionId: "s-main" },
    {
      id: "aaaa-bbbb",
      label: "  Budgey  ",
      cwd: "/tmp/work",
      sessionId: "s-budgey",
      createdAt: "2026-08-15T00:00:00.000Z",
    },
    { id: "loops", label: "Loops" },
    { id: "aaaa-bbbb", label: "dup" },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "aaaa-bbbb");
  assert.equal(list[0].label, "Budgey");
  assert.equal(list[0].sessionId, "s-budgey");
});

test("parseAgentRoster reads { agents } and a bare array", () => {
  const fromObj = parseAgentRoster({
    version: 1,
    agents: [{ id: "x", label: "Post Tracker", sessionId: "s1" }],
  });
  assert.equal(fromObj[0].label, "Post Tracker");
  const fromArr = parseAgentRoster([{ id: "y", label: "Other" }]);
  assert.equal(fromArr[0].id, "y");
  assert.deepEqual(parseAgentRoster(null), []);
});

test("save/load agent roster round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-agents-"));
  const file = join(dir, "phone-agents.json");
  try {
    await saveAgentRoster(file, [
      { id: "efdd5422-3f98-496f-96e7-fc3c20b550ff", label: "Post Tracker", sessionId: "sess-pt" },
    ]);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.agents[0].label, "Post Tracker");
    const loaded = await loadAgentRoster(file);
    assert.equal(loaded[0].sessionId, "sess-pt");
    assert.deepEqual(await loadAgentRoster(join(dir, "missing.json")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
