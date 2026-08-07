/**
 * Real merge path used by phone unlock (public/history-merge.mjs).
 * Proves user+bot same jobId both survive, and mid-flight bot rows exist for poll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historyEntryKey,
  mergeHostHistory,
  ensureActiveJobBotMessages,
} from "../public/history-merge.mjs";

test("historyEntryKey separates user and bot for same jobId", () => {
  assert.equal(
    historyEntryKey({ role: "user", jobId: "j1" }),
    "user:j1"
  );
  assert.equal(historyEntryKey({ role: "bot", jobId: "j1" }), "bot:j1");
  assert.notEqual(
    historyEntryKey({ role: "user", jobId: "j1" }),
    historyEntryKey({ role: "bot", jobId: "j1" })
  );
});

test("mergeHostHistory keeps paired user+bot turns for same jobId", () => {
  const host = [
    { role: "user", text: "Please review the PR", jobId: "job-99" },
    {
      role: "bot",
      text: "Review complete. Want me to implement the fixes?",
      jobId: "job-99",
      jobStatus: "done",
    },
    { role: "user", text: "Yes please", jobId: "job-100" },
    {
      role: "bot",
      text: "I'll start sealing cancelJob…",
      jobId: "job-100",
      jobStatus: "running",
    },
  ];
  // Local only has a short bot stub that must NOT wipe the user turn
  const local = [
    { role: "bot", text: "I'll", jobId: "job-100", jobStatus: "running" },
  ];

  const merged = mergeHostHistory(local, host, 80);

  const users = merged.filter((m) => m.role === "user" && m.jobId === "job-99");
  const bots = merged.filter((m) => m.role === "bot" && m.jobId === "job-99");
  assert.equal(users.length, 1, "user turn kept for job-99");
  assert.equal(bots.length, 1, "bot turn kept for job-99");
  assert.match(users[0].text, /review the PR/i);
  assert.match(bots[0].text, /Review complete/i);

  const u100 = merged.find((m) => m.role === "user" && m.jobId === "job-100");
  const b100 = merged.find((m) => m.role === "bot" && m.jobId === "job-100");
  assert.ok(u100, "user Yes please present");
  assert.ok(b100, "bot running present");
  assert.match(u100.text, /Yes please/i);
  // Longer host bot text wins over short local "I'll"
  assert.match(b100.text, /sealing cancelJob/i);
  assert.equal(b100.jobStatus, "running");

  // Full transcript length: 4 distinct turns
  assert.equal(
    merged.filter((m) => m.jobId === "job-99" || m.jobId === "job-100").length,
    4
  );
});

test("ensureActiveJobBotMessages adds bot row for mid-flight job without bot", () => {
  const messages = [
    { role: "user", text: "Do the work", jobId: "mid-1" },
    // bot missing (old collapse bug)
  ];
  const activeJobs = [
    {
      id: "mid-1",
      status: "running",
      reply: "Working on it…",
      text: "Do the work",
      tools: [{ name: "read_file", status: "running" }],
    },
  ];
  const fixed = ensureActiveJobBotMessages(messages, activeJobs);
  const bot = fixed.find((m) => m.role === "bot" && m.jobId === "mid-1");
  assert.ok(bot, "bot bubble created for reattach");
  assert.equal(bot.jobStatus, "running");
  assert.match(bot.text, /Working on it/);
  assert.ok(bot.tools && /read_file/.test(bot.tools));
  // user still present
  assert.ok(fixed.some((m) => m.role === "user" && m.jobId === "mid-1"));
});

test("reconnect does not duplicate local user rows that lack jobId", () => {
  // Host has full pairs with jobIds (Mac durable store)
  const host = [
    { role: "user", text: "Hi", jobId: "j1" },
    { role: "bot", text: "Hi — what would you like?", jobId: "j1", jobStatus: "done" },
    {
      role: "user",
      text: "Okay perfect. What were those 3 topics again?",
      jobId: "j2",
    },
    {
      role: "bot",
      text: "These were the three podcast angles…",
      jobId: "j2",
      jobStatus: "done",
    },
  ];
  // Local phone history: same user text WITHOUT jobId (pre-fix send path)
  const local = [
    { role: "user", text: "Hi" },
    { role: "bot", text: "Hi — what would you like?", jobId: "j1", jobStatus: "done" },
    { role: "user", text: "Okay perfect. What were those 3 topics again?" },
    {
      role: "bot",
      text: "These were the three podcast angles…",
      jobId: "j2",
      jobStatus: "done",
    },
  ];

  const merged = mergeHostHistory(local, host, 80);
  const users = merged.filter((m) => m.role === "user");
  const bots = merged.filter((m) => m.role === "bot");
  assert.equal(users.length, 2, "exactly two user bubbles");
  assert.equal(bots.length, 2, "exactly two bot bubbles");
  assert.equal(merged.length, 4, "no trailing duplicates");
  // Order preserved: user, bot, user, bot
  assert.equal(merged[0].role, "user");
  assert.equal(merged[1].role, "bot");
  assert.equal(merged[2].role, "user");
  assert.equal(merged[3].role, "bot");
  assert.match(merged[2].text, /3 topics/);
  // Local user without jobId got linked
  assert.equal(merged[2].jobId, "j2");
});

test("unlock rehydrate path: merge + ensure yields bot for poll reattach", () => {
  // Simulates showChat(): merge host messages then ensureActiveJobBotMessages
  const hostMessages = [
    { role: "user", text: "Implement reconnect", jobId: "r1" },
    // only user survived old bug on host side partially — bot partial:
    {
      role: "bot",
      text: "Partial progress text",
      jobId: "r1",
      jobStatus: "running",
    },
  ];
  const activeJobs = [
    {
      id: "r1",
      status: "running",
      reply: "Partial progress text",
      text: "Implement reconnect",
    },
    {
      id: "r2",
      status: "running",
      reply: "",
      text: "Second job only on activeJobs",
    },
  ];

  let history = mergeHostHistory([], hostMessages, 80);
  history = ensureActiveJobBotMessages(history, activeJobs);

  const botR1 = history.filter((m) => m.role === "bot" && m.jobId === "r1");
  const userR1 = history.filter((m) => m.role === "user" && m.jobId === "r1");
  assert.equal(userR1.length, 1);
  assert.equal(botR1.length, 1);
  assert.equal(botR1[0].jobStatus, "running");

  // r2 had no messages — ensure adds user+bot so UI can poll
  const botR2 = history.find((m) => m.role === "bot" && m.jobId === "r2");
  const userR2 = history.find((m) => m.role === "user" && m.jobId === "r2");
  assert.ok(botR2 && botR2.jobStatus === "running");
  assert.ok(userR2 && /Second job/.test(userR2.text));

  // Every running active job has a bot entry (poll reattach precondition)
  for (const j of activeJobs) {
    assert.ok(
      history.some((m) => m.role === "bot" && m.jobId === j.id),
      `missing bot for ${j.id}`
    );
  }
});
