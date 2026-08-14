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
  removeJobFromConversation,
  conversationToMessages,
  rebuildConversationFromJobs,
  buildTranscriptPromptContext,
  restoreAfterRestart,
  startFreshConversation,
  jobIsAfterClear,
  isMainAgentId,
  jobBelongsToMainConversation,
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

test("startFreshConversation + rebuild ignores pre-clear jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-clear-"));
  try {
    // Relative times — hard-coded calendar dates go stale as wall clock moves on
    const t = Date.now();
    const oldJob = {
      id: "old-usage",
      status: "done",
      text: "/usage",
      reply: "## Usage old",
      createdAt: new Date(t - 120_000).toISOString(),
      updatedAt: new Date(t - 119_000).toISOString(),
    };
    await writeFile(join(dir, "old.json"), JSON.stringify(oldJob));

    let state = emptyConversation();
    state = await rebuildConversationFromJobs(dir, state);
    assert.ok(
      conversationToMessages(state).some((m) => /usage/i.test(m.text)),
      "before clear, usage present"
    );

    state = startFreshConversation(state);
    assert.equal(state.turns.length, 0);
    assert.ok(state.clearedAt);
    assert.equal(jobIsAfterClear(oldJob, state.clearedAt), false);

    // Job that exists only after clear (timestamps strictly after clearedAt)
    const cut = Date.parse(state.clearedAt);
    const newJob = {
      id: "new-hi",
      status: "done",
      text: "Hi after clear",
      reply: "Hello",
      createdAt: new Date(cut + 1_000).toISOString(),
      updatedAt: new Date(cut + 2_000).toISOString(),
    };
    assert.equal(jobIsAfterClear(newJob, state.clearedAt), true);
    await writeFile(join(dir, "new.json"), JSON.stringify(newJob));

    // Simulate open after clear: rebuild must not re-append old jobs
    state = await rebuildConversationFromJobs(dir, state);
    const msgs = conversationToMessages(state);
    assert.ok(
      !msgs.some((m) => /usage/i.test(m.text)),
      "usage job must not return after clear"
    );
    assert.ok(
      msgs.some((m) => /Hi after clear|Hello/.test(m.text)),
      "post-clear job still included"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("removeJobFromConversation drops both turns for a job", () => {
  let state = emptyConversation("conv-del");
  state = upsertJobInConversation(state, {
    id: "q-del",
    status: "queued",
    text: "do the thing",
    reply: "",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  });
  assert.equal(state.turns.length, 2);
  state = removeJobFromConversation(state, "q-del");
  assert.equal(state.turns.length, 0);
});

test("isMainAgentId treats missing/default/auto as main", () => {
  assert.equal(isMainAgentId(undefined), true);
  assert.equal(isMainAgentId("main"), true);
  assert.equal(isMainAgentId("default"), true);
  assert.equal(isMainAgentId("auto"), true);
  assert.equal(isMainAgentId("bf0e936b-3267-4edd-9396-d6878fadb482"), false);
  assert.equal(
    jobBelongsToMainConversation({ agentId: "other-agent" }),
    false
  );
  assert.equal(jobBelongsToMainConversation({}), true);
  assert.equal(
    jobBelongsToMainConversation({ agentId: "main", loopId: "morning-brief" }),
    false
  );
  assert.equal(
    jobBelongsToMainConversation({ agentId: "main", source: "loop" }),
    false
  );
});

test("rebuildConversationFromJobs ignores extra-agent jobs and heals leaks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-agent-iso-"));
  try {
    await writeFile(
      join(dir, "main.json"),
      JSON.stringify({
        id: "main-job",
        status: "done",
        text: "What about the desktop UX plan?",
        reply: "The plan is written.",
        createdAt: "2026-08-12T19:00:00.000Z",
        updatedAt: "2026-08-12T19:00:10.000Z",
        agentId: "main",
      })
    );
    await writeFile(
      join(dir, "extra.json"),
      JSON.stringify({
        id: "extra-job",
        status: "done",
        text: "Other agent: implement watermark",
        reply: "Watermark is on disk.",
        createdAt: "2026-08-12T19:01:00.000Z",
        updatedAt: "2026-08-12T19:01:10.000Z",
        agentId: "bf0e936b-3267-4edd-9396-d6878fadb482",
      })
    );

    let state = emptyConversation();
    upsertJobInConversation(state, {
      id: "extra-job",
      status: "done",
      text: "Other agent: implement watermark",
      reply: "Watermark is on disk.",
      agentId: "bf0e936b-3267-4edd-9396-d6878fadb482",
    });
    assert.ok(
      conversationToMessages(state).some((m) => /watermark/i.test(m.text)),
      "precondition: leak present before rebuild"
    );

    state = await rebuildConversationFromJobs(dir, state);
    const msgs = conversationToMessages(state);
    assert.ok(
      msgs.some((m) => /desktop UX/i.test(m.text)),
      "main job stays"
    );
    assert.ok(
      !msgs.some((m) => /watermark/i.test(m.text)),
      "extra-agent job must not appear in main transcript"
    );
    assert.equal(
      msgs.filter((m) => m.jobId === "extra-job").length,
      0
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
