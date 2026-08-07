/**
 * Durable conversation + reconnect after bridge/agent restart.
 * Drives shipped lib/conversation.mjs (same path server uses).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyConversation,
  loadConversation,
  saveConversation,
  upsertJobInConversation,
  conversationToMessages,
  rebuildConversationFromJobs,
  buildTranscriptPromptContext,
  restoreAfterRestart,
} from "../lib/conversation.mjs";

test("session reconnect: prior assistant text survives restart seam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-conv-"));
  const store = join(dir, "phone-conversation.json");
  try {
    let state = emptyConversation("conv-reconnect-1");
    state.acpSessionId = "acp-session-abc";

    const job1 = {
      id: "job-1",
      status: "done",
      text: "Look at grok-phone-pwa",
      reply: "Here is the project overview with demux fixes.",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:10.000Z",
      finishedAt: "2026-08-07T00:00:10.000Z",
      sessionId: "acp-session-abc",
    };
    upsertJobInConversation(state, job1);
    await saveConversation(store, state);

    // Simulate bridge restart: in-memory agent dies; disk remains
    const live = { conversationId: "stale", acpSessionId: null };
    const disk = await loadConversation(store);
    const restored = restoreAfterRestart(live, disk);

    assert.equal(restored.conversationId, "conv-reconnect-1");
    assert.equal(restored.acpSessionId, "acp-session-abc");
    assert.ok(restored.priorAssistantTexts.length >= 1);
    assert.match(
      restored.priorAssistantTexts.join("\n"),
      /project overview|demux/i
    );

    const messages = conversationToMessages(disk);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "bot");
    assert.match(messages[1].text, /overview|demux/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcript inject includes prior turns for cold ACP session", () => {
  const state = emptyConversation();
  upsertJobInConversation(state, {
    id: "j1",
    status: "done",
    text: "Code review please",
    reply: "Want me to implement cancel/finalize next?",
    createdAt: "2026-08-07T01:00:00.000Z",
    updatedAt: "2026-08-07T01:05:00.000Z",
  });
  const ctx = buildTranscriptPromptContext(state.turns, "j2", 8);
  assert.match(ctx, /Code review/i);
  assert.match(ctx, /cancel\/finalize/i);
  assert.match(ctx, /durable phone conversation/i);
});

test("rebuildConversationFromJobs recovers text from job files only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-jobs-"));
  try {
    await writeFile(
      join(dir, "a.json"),
      JSON.stringify({
        id: "a",
        status: "done",
        text: "Hello",
        reply: "World from durable job",
        createdAt: "2026-08-07T02:00:00.000Z",
        updatedAt: "2026-08-07T02:00:05.000Z",
      })
    );
    const state = await rebuildConversationFromJobs(dir, emptyConversation());
    const msgs = conversationToMessages(state);
    assert.ok(msgs.some((m) => m.role === "user" && /Hello/.test(m.text)));
    assert.ok(
      msgs.some((m) => m.role === "bot" && /World from durable job/.test(m.text))
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
