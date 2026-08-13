import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertBrief, readBrief, readAllBriefs, briefIsFresh } from "../lib/briefs.mjs";

test("upsertBrief stores latest per loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-briefs-"));
  try {
    const file = join(dir, "briefs.json");
    upsertBrief(file, {
      loopId: "ads-health",
      agentName: "Ads health",
      bodyShort: "Spend is on plan.",
      bodyLong: "Yesterday $40. Plan $40. No broken ads.",
      kind: "update",
    });
    upsertBrief(file, {
      loopId: "ads-health",
      bodyShort: "Spend is a little high.",
      bodyLong: "Today $62 vs $40 plan.",
    });
    const got = readBrief(file, "ads-health");
    assert.match(got.bodyShort, /a little high/);
    assert.match(got.bodyLong, /\$62/);
    assert.equal(got.agentName, "Ads health");
    assert.equal(Object.keys(readAllBriefs(file)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("briefIsFresh is true within 20h or same local day", () => {
  const now = Date.parse("2026-08-13T16:00:00.000Z");
  assert.equal(
    briefIsFresh({ updatedAt: "2026-08-13T12:00:00.000Z" }, now, "America/New_York"),
    true
  );
  assert.equal(
    briefIsFresh({ updatedAt: "2026-08-12T12:00:00.000Z" }, now, "America/New_York"),
    false
  );
  assert.equal(briefIsFresh(null, now), false);
});
