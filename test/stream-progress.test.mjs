/**
 * Progressive agent stream → job state (shipped applySessionUpdate path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  applySessionUpdate,
  applyPromptDone,
  isTerminalJobStatus,
  forceTerminalizeJob,
} from "../lib/job-stream.mjs";

test("progressive ACP updates grow reply and tools before terminal", () => {
  const job = createJob({
    id: "stream-1",
    status: "running",
    text: "list files",
  });
  const snapshots = [];

  const snap = (label) => {
    snapshots.push({
      label,
      reply: job.reply,
      thought: job.thought,
      tools: job.tools.map((t) => ({ name: t.name, status: t.status })),
      status: job.status,
    });
  };

  // 1) first acknowledgment line
  let r = applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I'll look into that." },
  });
  assert.equal(r.progressed, true);
  snap("ack");
  assert.equal(job.reply, "I'll look into that.");
  assert.equal(isTerminalJobStatus(job.status), false);

  // 2) thought (does not mark hang progress)
  r = applySessionUpdate(job, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "planning shell command…" },
  });
  assert.equal(r.progressed, false);
  assert.match(job.thought, /planning/);
  snap("thought");

  // 3) tool start
  r = applySessionUpdate(job, {
    sessionUpdate: "tool_call",
    title: "run_terminal_command",
    status: "running",
  });
  assert.equal(r.progressed, true);
  assert.equal(job.tools.length, 1);
  assert.equal(job.tools[0].name, "run_terminal_command");
  snap("tool-start");

  // 4) tool complete
  r = applySessionUpdate(job, {
    sessionUpdate: "tool_call_update",
    title: "run_terminal_command",
    status: "completed",
  });
  assert.equal(r.progressed, true);
  assert.equal(job.tools[0].status, "completed");
  snap("tool-done");

  // 5) more assistant text (the real answer)
  r = applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "\n\n## Files\n- server.mjs\n- public/app.js" },
  });
  assert.equal(r.progressed, true);
  assert.match(job.reply, /server\.mjs/);
  snap("answer");

  // 6) prompt done
  applyPromptDone(job, { stopReason: "end_turn" });
  job.status = "done";
  job.finishedAt = new Date().toISOString();
  snap("done");

  assert.ok(snapshots.length >= 5);
  // intermediate: reply existed before final
  assert.ok(snapshots[0].reply.length > 0);
  assert.ok(snapshots[0].reply.length < snapshots[snapshots.length - 1].reply.length);
  // tools appeared mid-stream
  const withTools = snapshots.find((s) => s.tools.length > 0);
  assert.ok(withTools);
  // final terminal non-empty
  const final = snapshots[snapshots.length - 1];
  assert.equal(final.status, "done");
  assert.ok(final.reply.length > 20);
  assert.match(final.reply, /Files/);
});

test("applySessionUpdate is the production-shaped ingest (message/tool kinds)", () => {
  const job = createJob({ status: "running" });
  applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "A" },
  });
  applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "B" },
  });
  assert.equal(job.reply, "AB");
});

test("forceTerminalize after partial stream never leaves running", () => {
  const job = createJob({
    status: "running",
    reply: "I'll look into that.",
  });
  applySessionUpdate(job, {
    sessionUpdate: "tool_call",
    title: "run_terminal_command",
    status: "running",
  });
  forceTerminalizeJob(job, { reason: "idle timeout 240s" });
  assert.equal(job.status, "done");
  assert.ok(job.finishedAt);
  assert.match(job.reply, /I'll look into that/);
  assert.match(job.reply, /Stopped early|idle timeout/i);
});
