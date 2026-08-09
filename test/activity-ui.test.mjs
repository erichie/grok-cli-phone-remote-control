/**
 * Activity / left-menu pure helpers (public/activity-ui.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSelectedAgentId,
  agentStatusLine,
  agentDotKind,
  jobPreviewText,
  jobStatusLabel,
  jobIsActive,
  partitionJobs,
  activityBadgeCount,
  chatAgentIdPayload,
} from "../public/activity-ui.mjs";

const agents = [
  {
    id: "main",
    label: "Main",
    isMain: true,
    alive: true,
    agentReady: true,
    processing: false,
    queueLength: 0,
  },
  {
    id: "aaaa-bbbb",
    label: "Agent 1",
    isMain: false,
    alive: true,
    processing: true,
    currentJobId: "job-1",
    queueLength: 2,
  },
];

test("normalizeSelectedAgentId falls back to main when missing", () => {
  assert.equal(normalizeSelectedAgentId(agents, "gone"), "main");
  assert.equal(normalizeSelectedAgentId(agents, "default"), "main");
  assert.equal(normalizeSelectedAgentId(agents, "aaaa-bbbb"), "aaaa-bbbb");
  assert.equal(normalizeSelectedAgentId(agents, "auto"), "auto");
  assert.equal(normalizeSelectedAgentId(agents, ""), "main");
});

test("agentStatusLine and agentDotKind reflect busy/idle/stopped", () => {
  assert.equal(agentStatusLine(agents[0]), "Idle");
  assert.equal(agentDotKind(agents[0]), "ok");
  assert.equal(agentStatusLine(agents[1]), "Working · 2 queued");
  assert.equal(agentDotKind(agents[1]), "busy");
  assert.equal(agentStatusLine({ id: "x", alive: false }), "Stopped");
  assert.equal(agentDotKind({ id: "x" }), "off");
});

test("jobPreviewText prefers reply, then error, then user text", () => {
  assert.equal(
    jobPreviewText({ reply: "Hello world", text: "q" }),
    "Hello world"
  );
  assert.match(
    jobPreviewText({ error: "boom", text: "q", status: "error" }),
    /Error: boom/
  );
  assert.equal(jobPreviewText({ text: "please fix", status: "queued" }), "please fix");
  assert.equal(jobPreviewText({ status: "running" }), "Working…");
  assert.equal(jobPreviewText({ status: "queued" }), "Waiting in queue…");
});

test("jobStatusLabel and jobIsActive", () => {
  assert.equal(jobStatusLabel({ status: "running" }), "Running");
  assert.equal(
    jobStatusLabel({ status: "queued", queuePosition: 2 }),
    "Queued #2"
  );
  assert.equal(jobIsActive({ status: "running" }), true);
  assert.equal(jobIsActive({ status: "queued" }), true);
  assert.equal(jobIsActive({ status: "done" }), false);
});

test("partitionJobs splits active vs recent", () => {
  const jobs = [
    { id: "1", status: "running", createdAt: "2026-01-02T00:00:00Z", text: "a" },
    { id: "2", status: "done", createdAt: "2026-01-03T00:00:00Z", text: "b" },
    { id: "3", status: "queued", createdAt: "2026-01-04T00:00:00Z", text: "c" },
    { id: "4", status: "cancelled", createdAt: "2026-01-01T00:00:00Z", text: "d" },
  ];
  const { active, recent } = partitionJobs(jobs);
  assert.deepEqual(
    active.map((j) => j.id),
    ["3", "1"]
  );
  assert.deepEqual(
    recent.map((j) => j.id),
    ["2", "4"]
  );
});

test("activityBadgeCount only counts idle agents with a recent finished turn", () => {
  const now = Date.parse("2026-08-09T15:00:00.000Z");
  const readyAgents = [
    {
      id: "main",
      label: "Main",
      isMain: true,
      alive: true,
      agentReady: true,
      processing: false,
      queueLength: 0,
    },
    {
      id: "aaaa-bbbb",
      label: "Agent 1",
      isMain: false,
      alive: true,
      agentReady: true,
      processing: false,
      currentJobId: null,
      queueLength: 0,
    },
  ];
  const jobs = [
    {
      id: "1",
      status: "running",
      agentId: "main",
      updatedAt: "2026-08-09T14:59:00.000Z",
    },
    {
      id: "2",
      status: "done",
      agentId: "aaaa-bbbb",
      finishedAt: "2026-08-09T14:55:00.000Z",
    },
    {
      id: "3",
      status: "queued",
      agentId: "main",
    },
  ];
  // Only Agent 1 finished + idle; main is still working (running job / not ready)
  assert.equal(
    activityBadgeCount(jobs, readyAgents, { now, selectedAgentId: "main" }),
    1
  );
  // Viewing that agent clears the badge
  assert.equal(
    activityBadgeCount(jobs, readyAgents, {
      now,
      selectedAgentId: "aaaa-bbbb",
    }),
    0
  );
  // Busy agent does not count even if it has a done job in the list
  const busy = [
    {
      ...readyAgents[1],
      processing: true,
      currentJobId: "job-x",
    },
  ];
  assert.equal(
    activityBadgeCount(jobs, busy, { now, selectedAgentId: "main" }),
    0
  );
  assert.equal(activityBadgeCount([], readyAgents, { now }), 0);
});

test("chatAgentIdPayload normalizes default", () => {
  assert.equal(chatAgentIdPayload(null), "main");
  assert.equal(chatAgentIdPayload("default"), "main");
  assert.equal(chatAgentIdPayload("auto"), "auto");
  assert.equal(chatAgentIdPayload("uuid-1"), "uuid-1");
});
