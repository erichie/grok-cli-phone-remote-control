/**
 * Hang recovery: partial ack + silence → force terminalize within bound.
 * Also exercises real TerminalManager (agent→client ACP terminal path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  applySessionUpdate,
  forceTerminalizeJob,
  isTerminalJobStatus,
  createHangWatch,
} from "../lib/job-stream.mjs";
import {
  TerminalManager,
  autoApprovePermission,
} from "../lib/terminal-manager.mjs";
import { readTextFile, writeTextFile, defaultAllowedRoots } from "../lib/fs-handlers.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

test("hang watch detects idle after partial ack with no further progress", () => {
  let fakeNow = 1_000_000;
  const watch = createHangWatch({
    idleMs: 5_000,
    maxMs: 60_000,
    now: () => fakeNow,
  });

  const job = createJob({ status: "running", reply: "" });
  applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I'll check." },
  });
  watch.markProgress();

  // thought-only should NOT be used by caller to markProgress — simulate silence
  applySessionUpdate(job, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "still thinking…" },
  });

  fakeNow += 4_000;
  assert.equal(watch.check(), null);

  fakeNow += 2_000; // total 6s idle
  assert.equal(watch.check(), "idle");

  forceTerminalizeJob(job, { reason: "idle timeout 5s" });
  assert.ok(isTerminalJobStatus(job.status));
  assert.notEqual(job.status, "running");
  assert.ok((job.reply || "").length > 0 || (job.error || "").length > 0);
});

test("empty hung job becomes error terminal with clear reason", () => {
  const job = createJob({ status: "running", reply: "" });
  forceTerminalizeJob(job, { reason: "agent process exited" });
  assert.equal(job.status, "error");
  assert.match(job.reply, /agent process exited|Error/);
  assert.ok(job.finishedAt);
});

test("TerminalManager create → wait_for_exit → output (ACP shape)", async () => {
  const tm = new TerminalManager();
  const { terminalId } = tm.create({
    command: "/bin/bash -lc 'echo hello-from-phone-bridge'",
    cwd: process.cwd(),
    env: [{ name: "CI", value: "true" }],
    outputByteLimit: 20000,
  });
  assert.ok(terminalId);

  const exit = await tm.waitForExit(terminalId);
  assert.equal(exit.exitCode, 0);

  const out = tm.output(terminalId);
  assert.match(out.output, /hello-from-phone-bridge/);
  assert.equal(out.truncated, false);
  assert.ok(out.exitStatus);
  assert.equal(out.exitStatus.exitCode, 0);

  await tm.release(terminalId);
  assert.throws(() => tm.output(terminalId));
});

test("TerminalManager kill stops long-running command", async () => {
  const tm = new TerminalManager();
  const { terminalId } = tm.create({
    command: "/bin/bash -lc 'sleep 30'",
    cwd: process.cwd(),
  });
  await tm.kill(terminalId);
  const exit = await tm.waitForExit(terminalId);
  assert.ok(exit.exitCode != null || exit.signal);
  await tm.release(terminalId);
});

test("autoApprovePermission prefers allow_always", () => {
  const outcome = autoApprovePermission([
    { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "ok-always", kind: "allow_always", name: "Always" },
    { optionId: "ok-once", kind: "allow_once", name: "Once" },
  ]);
  assert.deepEqual(outcome, {
    outcome: "selected",
    optionId: "ok-always",
  });
});

test("fs read/write handlers under allowed roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-fs-"));
  try {
    const roots = defaultAllowedRoots(dir);
    const path = join(dir, "note.txt");
    await writeTextFile({ path, content: "hello-fs" }, roots);
    const { content } = await readTextFile({ path }, roots);
    assert.equal(content, "hello-fs");
    await assert.rejects(
      () => readTextFile({ path: "/etc/passwd" }, roots),
      /not allowed/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
