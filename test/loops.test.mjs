import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readLocalLoops,
  nextRunAt,
  scheduleLabel,
  listLoops,
  recordLoopRun,
  readLoopState,
  isLoopDue,
} from "../lib/loops.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("example loops file is valid and generic", () => {
  const raw = JSON.parse(
    readFileSync(join(root, "examples/phone-loops.example.json"), "utf8")
  );
  assert.ok(Array.isArray(raw.loops));
  assert.ok(raw.loops.length >= 1);
  const blob = JSON.stringify(raw);
  assert.doesNotMatch(blob, /10k MRR|hockeyline|Budgey/i);
  for (const loop of raw.loops) {
    assert.ok(loop.id && loop.name && loop.schedule?.kind);
  }
  const synth = raw.loops.find((l) => l.role === "synth");
  assert.ok(synth, "example should include a synth / CoS loop");
  assert.ok(Array.isArray(synth.reads) && synth.reads.length >= 1);
});

test("readLocalLoops returns missing when file is absent", () => {
  const got = readLocalLoops("/tmp/does-not-exist-phone-loops.json");
  assert.equal(got.source, "missing");
  assert.deepEqual(got.loops, []);
});

test("readLocalLoops loads definitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-loops-"));
  try {
    const file = join(dir, "loops.json");
    await writeFile(
      file,
      JSON.stringify({
        loops: [
          {
            id: "morning-brief",
            name: "Morning brief",
            description: "Daily paper",
            schedule: { kind: "weekdays", time: "08:00", tz: "America/New_York" },
          },
        ],
      })
    );
    const got = readLocalLoops(file);
    assert.equal(got.source, "local");
    assert.equal(got.loops[0].name, "Morning brief");
    assert.match(scheduleLabel(got.loops[0].schedule), /weekdays 08:00 ET/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nextRunAt finds the next weekday 08:00 ET", () => {
  // Thursday 13 Aug 2026 12:01 UTC = 08:01 ET
  const now = Date.parse("2026-08-13T12:01:00.000Z");
  const next = nextRunAt(
    { kind: "weekdays", time: "08:00", tz: "America/New_York" },
    now
  );
  assert.ok(next);
  // Friday 14 Aug 2026 08:00 ET = 12:00 UTC
  assert.equal(next, "2026-08-14T12:00:00.000Z");
});

test("listLoops merges last-run state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-loops-state-"));
  try {
    const statePath = join(dir, "state.json");
    recordLoopRun(statePath, "morning-brief", {
      at: "2026-08-13T12:00:00.000Z",
      status: "ok",
      summary: "Posted standup",
    });
    const listed = listLoops(
      [
        {
          id: "morning-brief",
          name: "Morning brief",
          enabled: true,
          schedule: { kind: "weekdays", time: "08:00", tz: "America/New_York" },
        },
      ],
      readLoopState(statePath),
      Date.parse("2026-08-13T16:00:00.000Z")
    );
    assert.equal(listed[0].lastRunAt, "2026-08-13T12:00:00.000Z");
    assert.equal(listed[0].lastSummary, "Posted standup");
    assert.ok(listed[0].nextRunAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isLoopDue only fires inside the slack window", () => {
  const sched = { kind: "weekdays", time: "08:00", tz: "America/New_York" };
  // Thursday 13 Aug 2026 08:00 ET = 12:00 UTC
  const atSlot = Date.parse("2026-08-13T12:00:20.000Z");
  assert.equal(isLoopDue(sched, null, atSlot), true);
  assert.equal(isLoopDue(sched, "2026-08-13T12:00:05.000Z", atSlot), false);
  const afternoon = Date.parse("2026-08-13T16:00:00.000Z");
  assert.equal(isLoopDue(sched, null, afternoon), false);
});

test("HTML has a Loops page", () => {
  const html = readFileSync(join(root, "public/index.html"), "utf8");
  assert.match(html, /id="nav-loops"/);
  assert.match(html, /id="page-loops"/);
  assert.match(html, /id="page-loops-list"/);
});
