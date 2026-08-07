/**
 * Mid-flight / terminal job body reloads from durable store after reconnect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyConversation,
  upsertJobInConversation,
  conversationToMessages,
  rebuildConversationFromJobs,
  saveConversation,
  loadConversation,
} from "../lib/conversation.mjs";

test("partial running job reply is non-empty after transcript reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-partial-"));
  const store = join(dir, "conv.json");
  const jobsDir = join(dir, "jobs");
  await (await import("node:fs/promises")).mkdir(jobsDir);
  try {
    const partialJob = {
      id: "mid-1",
      status: "running",
      text: "Implement the fixes",
      reply: "I'll start with cancelJob sealing…",
      tools: [{ name: "read_file", status: "running" }],
      createdAt: "2026-08-07T03:00:00.000Z",
      updatedAt: "2026-08-07T03:01:00.000Z",
      sessionId: "sess-mid",
    };
    await writeFile(join(jobsDir, "mid-1.json"), JSON.stringify(partialJob));

    let state = emptyConversation("c1");
    upsertJobInConversation(state, partialJob);
    await saveConversation(store, state);

    // Reconnect: load store + rebuild from jobs (server handleConversation path)
    state = await loadConversation(store);
    state = await rebuildConversationFromJobs(jobsDir, state);
    const messages = conversationToMessages(state);
    const bot = messages.find((m) => m.jobId === "mid-1" && m.role === "bot");
    assert.ok(bot, "assistant turn present");
    assert.ok((bot.text || "").trim().length > 0, "body non-empty");
    assert.match(bot.text, /cancelJob sealing/i);
    assert.equal(bot.jobStatus, "running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal job final reply matches durable store after rebuild", async () => {
  const jobsDir = await mkdtemp(join(tmpdir(), "phone-final-"));
  try {
    const finalText =
      "multi-a\nmulti-b\nmulti-c — full answer after shell tools.";
    await writeFile(
      join(jobsDir, "done-1.json"),
      JSON.stringify({
        id: "done-1",
        status: "done",
        text: "Run three echos",
        reply: finalText,
        createdAt: "2026-08-07T04:00:00.000Z",
        finishedAt: "2026-08-07T04:00:15.000Z",
        updatedAt: "2026-08-07T04:00:15.000Z",
      })
    );
    const state = await rebuildConversationFromJobs(
      jobsDir,
      emptyConversation()
    );
    const bot = conversationToMessages(state).find(
      (m) => m.jobId === "done-1" && m.role === "bot"
    );
    assert.equal(bot.text, finalText);
    assert.equal(bot.jobStatus, "done");
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});
