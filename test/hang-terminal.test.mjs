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
import {
  readTextFile,
  writeTextFile,
  defaultAllowedRoots,
  isPathAllowed,
  resolvePathSafe,
} from "../lib/fs-handlers.mjs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

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

test("defaultAllowedRoots excludes home unless allowHome", () => {
  const dir = join(tmpdir(), "workspace-fake");
  const narrow = defaultAllowedRoots(dir);
  const home = resolvePathSafe(homedir());
  // Home itself should not be a root by default (unless home === cwd, rare).
  if (resolvePathSafe(dir) !== home) {
    assert.equal(
      narrow.some((r) => r === home),
      false,
      "home must not be an allowed root by default"
    );
  }
  const wide = defaultAllowedRoots(dir, { allowHome: true });
  assert.ok(wide.some((r) => r === home || home.startsWith(r + "/")));
});

test("isPathAllowed blocks symlink escape outside roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-fs-sym-"));
  try {
    // Only the workspace root — not tmpdir/home — so a sibling path is outside.
    const roots = [resolvePathSafe(dir)];
    const outsideDir = await mkdtemp(join(tmpdir(), "phone-fs-out-"));
    try {
      const secret = join(outsideDir, "secret.txt");
      await writeFile(secret, "classified", "utf8");
      const link = join(dir, "escape-link");
      await symlink(secret, link);
      // Symlink path is under dir, but realpath points outside roots.
      assert.equal(isPathAllowed(link, roots), false);
      await assert.rejects(
        () => readTextFile({ path: link }, roots),
        /not allowed/
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isPathAllowed allows normal files under root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-fs-ok-"));
  try {
    const roots = defaultAllowedRoots(dir);
    const path = join(dir, "ok.txt");
    await writeFile(path, "ok", "utf8");
    assert.equal(isPathAllowed(path, roots), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
