/**
 * Multi-agent registry + process-group kill helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentRegistry,
  killProcessTree,
} from "../lib/agent-registry.mjs";

function fakeAcp(cwd) {
  const state = {
    cwd,
    sessionId: null,
    preferredSessionId: null,
    proc: null,
    terminals: { terminals: new Map() },
    stopCount: 0,
    cancelCount: 0,
    resetCount: 0,
    startCount: 0,
  };
  return {
    get sessionId() {
      return state.sessionId;
    },
    set sessionId(v) {
      state.sessionId = v;
    },
    get preferredSessionId() {
      return state.preferredSessionId;
    },
    set preferredSessionId(v) {
      state.preferredSessionId = v;
    },
    get proc() {
      return state.proc;
    },
    set proc(v) {
      state.proc = v;
    },
    terminals: state.terminals,
    async start() {
      state.startCount++;
      state.sessionId = "sess-" + state.startCount;
      state.proc = { pid: 1000 + state.startCount, killed: false };
      return state.sessionId;
    },
    async stop() {
      state.stopCount++;
      if (state.proc) state.proc.killed = true;
      state.proc = null;
      state.sessionId = null;
    },
    async cancel() {
      state.cancelCount++;
    },
    async reset() {
      state.resetCount++;
      await this.stop();
      return this.start();
    },
    _state: state,
  };
}

test("registry starts with main slot only", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
    maxAgents: 3,
  });
  assert.equal(reg.size, 1);
  assert.equal(reg.main.id, "main");
  assert.equal(reg.main.isMain, true);
  assert.equal(reg.get("main"), reg.main);
  assert.equal(reg.get("default"), reg.main);
  assert.equal(reg.get(null), reg.main);
});

test("restore recreates extras with the same id and session", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/work",
    maxAgents: 4,
  });
  const restored = reg.restore([
    {
      id: "5e707bec-515d-45b8-a5fb-0d1502ae9824",
      label: "Budgey",
      cwd: "/work",
      sessionId: "sess-budgey-1",
    },
    { id: "main", label: "ignored" },
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, "5e707bec-515d-45b8-a5fb-0d1502ae9824");
  assert.equal(restored[0].label, "Budgey");
  const slot = reg.get("5e707bec-515d-45b8-a5fb-0d1502ae9824");
  assert.equal(slot.acp.preferredSessionId, "sess-budgey-1");
  const snap = reg.snapshotExtras();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].sessionId, "sess-budgey-1");
});

test("create adds concurrent agents up to maxAgents", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
    maxAgents: 3,
  });
  const a = reg.create({ label: "Worker A" });
  assert.equal(a.label, "Worker A");
  assert.equal(a.isMain, false);
  assert.equal(reg.size, 2);
  reg.create({ label: "Worker B" });
  assert.equal(reg.size, 3);
  assert.throws(() => reg.create({ label: "Too many" }), (err) => {
    assert.equal(err.code, "MAX_AGENTS");
    return true;
  });
});

test("publicAgent reports queue and process state", async () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/work",
    maxAgents: 4,
  });
  await reg.main.acp.start();
  reg.main.jobQueue.push("j1", "j2");
  reg.main.currentJobId = "j0";
  reg.main.queueRunning = true;
  const pub = reg.list().find((a) => a.id === "main");
  assert.equal(pub.queueLength, 2);
  assert.equal(pub.processing, true);
  assert.equal(pub.currentJobId, "j0");
  assert.equal(pub.alive, true);
  assert.ok(pub.pid);
  assert.equal(pub.cwd, "/work");
});

test("stop removes extra agents and drains queue", async () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
    maxAgents: 4,
  });
  const created = reg.create({ label: "Temp" });
  const slot = reg.get(created.id);
  await slot.acp.start();
  slot.jobQueue.push("x");
  slot.currentJobId = "y";
  slot.queueRunning = true;

  const out = await reg.stop(created.id, { remove: true });
  assert.equal(out.removed, true);
  assert.equal(reg.get(created.id), null);
  assert.equal(reg.size, 1);
  assert.equal(slot.acp._state.stopCount, 1);
});

test("stop on main resets instead of removing", async () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
  });
  await reg.main.acp.start();
  reg.main.jobQueue.push("q");
  const out = await reg.stop("main", { remove: true });
  assert.equal(out.removed, false);
  assert.equal(reg.size, 1);
  assert.ok(reg.main.acp.sessionId); // reset restarts
  assert.equal(reg.main.jobQueue.length, 0);
});

test("stopAllExtras removes every non-main agent", async () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
    maxAgents: 6,
  });
  reg.create({ label: "A" });
  reg.create({ label: "B" });
  assert.equal(reg.size, 3);
  const out = await reg.stopAllExtras();
  assert.equal(out.removed.length, 2);
  assert.equal(reg.size, 1);
});

test("require throws AGENT_NOT_FOUND", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
  });
  assert.throws(() => reg.require("missing"), (err) => {
    assert.equal(err.code, "AGENT_NOT_FOUND");
    return true;
  });
});

test("rename updates label for main and extras", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
  });
  const main = reg.rename("main", "  Mac workspace  ");
  assert.equal(main.label, "Mac workspace");
  const created = reg.create({ label: "Temp" });
  const renamed = reg.rename(created.id, "Refactor PR");
  assert.equal(renamed.label, "Refactor PR");
  assert.equal(reg.list().find((a) => a.id === created.id)?.label, "Refactor PR");
});

test("rename falls back when label is empty whitespace", () => {
  const reg = createAgentRegistry({
    createAcp: (cwd) => fakeAcp(cwd),
    defaultCwd: "/tmp",
  });
  const main = reg.rename("main", "   ");
  assert.equal(main.label, "Main");
});

test("killProcessTree is a no-op for null/killed procs", async () => {
  await killProcessTree(null);
  await killProcessTree({ killed: true, pid: 1 });
});

test("killProcessTree SIGTERMs then SIGKILLs a live mock proc", async () => {
  const signals = [];
  const proc = {
    pid: 424242,
    killed: false,
    kill(sig) {
      signals.push(sig);
      if (sig === "SIGKILL") this.killed = true;
    },
  };
  // Patch process.kill for group path — may throw if not group leader
  const orig = process.kill;
  process.kill = (pid, sig) => {
    signals.push(`group:${pid}:${sig}`);
    // simulate not a group leader so fallback to proc.kill
    throw new Error("ESRCH");
  };
  try {
    await killProcessTree(proc, { graceMs: 20 });
  } finally {
    process.kill = orig;
  }
  assert.ok(signals.includes("SIGTERM") || signals.some((s) => String(s).includes("SIGTERM")));
  assert.ok(proc.killed || signals.includes("SIGKILL") || signals.some((s) => String(s).includes("SIGKILL")));
});
