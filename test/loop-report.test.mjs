import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLoopReport,
  resolveReads,
  gatherSynthInputs,
  buildSynthPrompt,
  buildSpecialistPrompt,
} from "../lib/loop-report.mjs";

test("parseLoopReport reads SHORT/BRIEF/KIND blocks", () => {
  const got = parseLoopReport(
    "noise\n\nSHORT:\nSpend is on plan.\n\nBRIEF:\nChecked Meta. $40 vs $40.\n\nKIND:\nupdate\n"
  );
  assert.equal(got.bodyShort, "Spend is on plan.");
  assert.match(got.bodyLong, /Checked Meta/);
  assert.equal(got.kind, "update");
});

test("parseLoopReport reads JSON fence", () => {
  const got = parseLoopReport(
    '```json\n{"bodyShort":"No replies.","bodyLong":"Scanned 4 threads.","kind":"update"}\n```'
  );
  assert.equal(got.bodyShort, "No replies.");
  assert.match(got.bodyLong, /4 threads/);
});

test("parseLoopReport falls back to first paragraph", () => {
  const got = parseLoopReport("One line card.\n\nMore detail here.");
  assert.match(got.bodyShort, /One line card/);
  assert.match(got.bodyLong, /More detail/);
});

test("resolveReads uses explicit list or other specialists", () => {
  const loops = [
    { id: "ads-health", role: "specialist", enabled: true },
    { id: "inbox-watch", role: "specialist", enabled: true },
    { id: "morning-brief", role: "synth", reads: ["ads-health"], enabled: true },
  ];
  assert.deepEqual(resolveReads(loops[2], loops), ["ads-health"]);
  assert.deepEqual(resolveReads({ id: "morning-brief", role: "synth" }, loops), [
    "ads-health",
    "inbox-watch",
  ]);
});

test("gatherSynthInputs marks missing briefs as no report", () => {
  const loops = [
    { id: "ads-health", name: "Ads health", role: "specialist", enabled: true },
    {
      id: "morning-brief",
      name: "Morning brief",
      role: "synth",
      reads: ["ads-health", "inbox-watch"],
      schedule: { tz: "America/New_York" },
    },
  ];
  const now = Date.parse("2026-08-13T16:00:00.000Z");
  const inputs = gatherSynthInputs(
    loops[1],
    loops,
    {
      "ads-health": {
        loopId: "ads-health",
        bodyShort: "On plan.",
        bodyLong: "$40 vs $40.",
        updatedAt: "2026-08-13T12:10:00.000Z",
      },
    },
    now
  );
  assert.equal(inputs[0].present, true);
  assert.equal(inputs[1].present, false);
  const prompt = buildSynthPrompt(loops[1], inputs, { north_star: "Ship the weekly issue" });
  assert.match(prompt, /On plan|\$40/);
  assert.match(prompt, /NO REPORT TODAY/);
  assert.match(prompt, /do not invent/i);
  assert.doesNotMatch(prompt, /10k MRR/i);
});

test("specialist prompt asks for a brief", () => {
  const p = buildSpecialistPrompt({
    name: "Ads health",
    description: "Check spend.",
  });
  assert.match(p, /BRIEF:/);
  assert.match(p, /Chief of Staff/);
});
