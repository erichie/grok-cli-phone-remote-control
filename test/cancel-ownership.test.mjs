/**
 * Job ownership: cancel / finalize seal the job so stream + headless cannot hang
 * or overwrite the phone-visible result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJob,
  applySessionUpdate,
  forceTerminalizeJob,
  isTerminalJobStatus,
} from "../lib/job-stream.mjs";
import {
  isJobSealed,
  sealJob,
  isShortFollowUp,
  buildRecentContextBlock,
  isQueuedWaitingJob,
  applyQueuedJobText,
  promoteQueuedJob,
} from "../lib/job-ownership.mjs";

/**
 * Mirrors server runJob ownership: once sealed, later status writes must not run.
 */
function simulatePostCancelOverwriteGuard(job, attemptStatus) {
  if (isJobSealed(job)) return job;
  job.status = attemptStatus;
  return job;
}

test("sealJob sets userFinalized + terminal status", () => {
  const job = createJob({ status: "running", reply: "partial" });
  sealJob(job, {
    status: "cancelled",
    error: "cancelled",
    reply: "_(cancelled)_",
  });
  assert.equal(job.userFinalized, true);
  assert.equal(job.status, "cancelled");
  assert.equal(isJobSealed(job), true);
  assert.equal(isTerminalJobStatus(job.status), true);
});

test("cancel ownership: sealed job blocks status overwrite", () => {
  const job = createJob({
    status: "running",
    reply: "partial",
    userFinalized: false,
  });
  sealJob(job, {
    status: "cancelled",
    error: "cancelled",
    reply: job.reply || "_(cancelled)_",
  });

  simulatePostCancelOverwriteGuard(job, "done");
  assert.equal(job.status, "cancelled");
  assert.equal(job.userFinalized, true);
});

test("finalize ownership: sealed job blocks forceTerminalize rewrite", () => {
  const job = createJob({
    status: "running",
    reply: "almost done",
  });
  sealJob(job, {
    status: "done",
    error: null,
    reply: "almost done\n\n_(Stopped early)_",
  });

  if (!isJobSealed(job)) {
    forceTerminalizeJob(job, { reason: "no terminal status" });
  }
  assert.equal(job.status, "done");
  assert.match(job.reply, /Stopped early/);
});

test("stream updates ignored after seal (no reply growth)", () => {
  const job = createJob({ status: "running", reply: "hello" });
  sealJob(job, {
    status: "done",
    error: null,
    reply: "hello\n\n_(Stopped early)_",
  });
  const before = job.reply;
  const r = applySessionUpdate(job, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: " MORE SHOULD NOT APPEND" },
  });
  assert.equal(r.sealed, true);
  assert.equal(r.progressed, false);
  assert.equal(job.reply, before);
});

test("without seal, cancelled can be overwritten (documents the old bug)", () => {
  const job = createJob({
    status: "cancelled",
    userFinalized: false,
    reply: "_(cancelled)_",
  });
  // status cancelled alone used to not be enough if code only checked userFinalized
  // isJobSealed now treats terminal status as sealed too
  assert.equal(isJobSealed(job), true);
  simulatePostCancelOverwriteGuard(job, "done");
  assert.equal(job.status, "cancelled");
});

test("isQueuedWaitingJob is only true for waiting queued jobs", () => {
  assert.equal(
    isQueuedWaitingJob({ id: "q1", status: "queued" }, null),
    true
  );
  assert.equal(
    isQueuedWaitingJob({ id: "q1", status: "queued" }, "q1"),
    false
  );
  assert.equal(
    isQueuedWaitingJob({ id: "q1", status: "running" }, null),
    false
  );
  assert.equal(
    isQueuedWaitingJob({ id: "q1", status: "queued", userFinalized: true }, null),
    false
  );
});

test("promoteQueuedJob moves an id to the front", () => {
  const q = ["a", "b", "c"];
  assert.equal(promoteQueuedJob(q, "c"), true);
  assert.deepEqual(q, ["c", "a", "b"]);
  assert.equal(promoteQueuedJob(q, "c"), true);
  assert.deepEqual(q, ["c", "a", "b"]);
  assert.equal(promoteQueuedJob(q, "missing"), false);
});

test("applyQueuedJobText updates text and rejects empty", () => {
  const job = createJob({ id: "q1", status: "queued", text: "old" });
  applyQueuedJobText(job, "  new ask  ");
  assert.equal(job.text, "new ask");
  assert.throws(() => applyQueuedJobText(job, "   "), /text is required/);
});

test("isShortFollowUp detects yes-please style confirmations", () => {
  assert.equal(isShortFollowUp("Yes please"), true);
  assert.equal(isShortFollowUp("ok"), true);
  assert.equal(isShortFollowUp("do it"), true);
  assert.equal(isShortFollowUp("go ahead"), true);
  assert.equal(
    isShortFollowUp("Can you implement the cancel fixes?"),
    false
  );
  assert.equal(isShortFollowUp(""), false);
});

test("server and client expose queued edit/delete", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const serverJs = readFileSync(join(root, "server.mjs"), "utf8");
  const appJs = readFileSync(join(root, "public/app.js"), "utf8");
  assert.match(serverJs, /handleJobPatch/);
  assert.match(serverJs, /handleJobDelete/);
  assert.match(serverJs, /handleJobSendNow/);
  assert.match(serverJs, /editQueuedJob/);
  assert.match(appJs, /syncQueuedMsgActions/);
  assert.match(appJs, /bindQueuedLongPress/);
  assert.match(appJs, /QUEUE_LONG_PRESS_MS/);
  assert.match(appJs, /saveQueuedEdit/);
  assert.match(appJs, /sendQueuedMessageNow/);
  assert.match(appJs, /deleteQueuedMessage/);
  const html = readFileSync(join(root, "public/index.html"), "utf8");
  assert.match(html, /id="queue-sheet"/);
  assert.match(html, /id="queue-send-now"/);
  assert.doesNotMatch(appJs, /className = "queue-actions"/);
});

test("buildRecentContextBlock includes prior Q/A for cold sessions", () => {
  const prior = createJob({
    id: "prior-1",
    status: "done",
    text: "Can you code review it?",
    reply: "Want me to implement the cancel/finalize fixes next?",
  });
  const block = buildRecentContextBlock([prior], "current-id", 2);
  assert.match(block, /code review/i);
  assert.match(block, /cancel\/finalize/i);
  assert.match(block, /Prior turn/);
});
