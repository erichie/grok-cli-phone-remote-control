/**
 * ACP demux: agent→client requests must never resolve pending client calls,
 * even when JSON-RPC ids collide (the root multi-minute hang).
 *
 * Drives the real AcpLineHandler used by GrokAcp in server.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAcpLine, dispatchAcpLine } from "../lib/acp-demux.mjs";
import { AcpLineHandler } from "../lib/acp-line-handler.mjs";
import { TerminalManager } from "../lib/terminal-manager.mjs";
import { defaultAllowedRoots } from "../lib/fs-handlers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("classifyAcpLine: method+id is agent_request even if id is pending-shaped", () => {
  const msg = {
    jsonrpc: "2.0",
    id: 3,
    method: "terminal/create",
    params: { command: "echo hi", sessionId: "s" },
  };
  const c = classifyAcpLine(msg);
  assert.equal(c.type, "agent_request");
  assert.equal(c.id, 3);
  assert.equal(c.method, "terminal/create");
});

test("classifyAcpLine: response has no method", () => {
  const c = classifyAcpLine({
    jsonrpc: "2.0",
    id: 3,
    result: { stopReason: "end_turn" },
  });
  assert.equal(c.type, "response");
  assert.equal(c.id, 3);
});

test("dispatchAcpLine: colliding terminal/create does NOT resolve pending prompt", () => {
  const pending = new Map();
  let promptResolved = false;
  let promptRejected = false;
  pending.set(3, {
    resolve: () => {
      promptResolved = true;
    },
    reject: () => {
      promptRejected = true;
    },
  });

  const agentReqs = [];
  const out = dispatchAcpLine(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "terminal/create",
      params: { command: "/bin/bash -lc 'echo hi'", sessionId: "s" },
    },
    pending,
    {
      onAgentRequest: (msg) => agentReqs.push(msg),
    }
  );

  assert.equal(out.kind, "agent_request");
  assert.equal(out.resolvedPending, false);
  assert.equal(out.pendingStillHasId, true);
  assert.equal(pending.has(3), true);
  assert.equal(promptResolved, false);
  assert.equal(promptRejected, false);
  assert.equal(agentReqs.length, 1);
  assert.equal(agentReqs[0].method, "terminal/create");
});

test("AcpLineHandler: pending prompt id=N + agent {method,id:N} is answered, not prompt success", async () => {
  const written = [];
  const terminals = new TerminalManager();
  const handler = new AcpLineHandler({
    terminals,
    allowedRoots: defaultAllowedRoots(process.cwd()),
    writeMessage: (obj) => written.push(obj),
  });

  // Simulate in-flight session/prompt as client request id=3
  let promptResult = null;
  let promptError = null;
  const promptPromise = new Promise((resolve, reject) => {
    handler.trackPending(3, {
      resolve: (r) => {
        promptResult = r;
        resolve(r);
      },
      reject: (e) => {
        promptError = e;
        reject(e);
      },
    });
  });

  assert.equal(handler.hasPending(3), true);

  // Agent sends terminal/create with the SAME id=3 (the hang collision)
  handler.onLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "terminal/create",
      params: {
        sessionId: "sess-test",
        command: "/bin/bash -lc 'echo demux-collision-ok'",
        cwd: process.cwd(),
        outputByteLimit: 20000,
      },
    })
  );

  // Allow async create reply
  await new Promise((r) => setTimeout(r, 50));

  // Prompt must STILL be pending — not falsely resolved as empty success
  assert.equal(handler.hasPending(3), true);
  assert.equal(promptResult, null);
  assert.equal(promptError, null);

  // Agent request must have been answered with terminalId
  assert.ok(written.length >= 1, "expected reply to agent");
  const reply = written.find((w) => w.id === 3 && w.result);
  assert.ok(reply, "expected result for id=3 terminal/create");
  assert.ok(reply.result.terminalId, "expected terminalId in result");
  assert.equal(reply.error, undefined);

  // Real terminal follow-up: wait_for_exit with a different id still works
  // while prompt stays pending
  const termId = reply.result.terminalId;
  handler.onLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "terminal/wait_for_exit",
      params: { sessionId: "sess-test", terminalId: termId },
    })
  );
  await new Promise((r) => setTimeout(r, 200));
  const waitReply = written.find((w) => w.id === 0 && w.result);
  assert.ok(waitReply);
  assert.equal(waitReply.result.exitCode, 0);
  assert.equal(handler.hasPending(3), true);

  // Genuine prompt response (no method) finally resolves pending
  handler.onLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" },
    })
  );
  await promptPromise;
  assert.equal(handler.hasPending(3), false);
  assert.deepEqual(promptResult, { stopReason: "end_turn" });

  await terminals.releaseAll();
});

test("AcpLineHandler multi-tool: sequential terminal ids 0..3 while prompt is id=3", async () => {
  const written = [];
  const terminals = new TerminalManager();
  const handler = new AcpLineHandler({
    terminals,
    allowedRoots: defaultAllowedRoots(process.cwd()),
    writeMessage: (obj) => written.push(obj),
  });

  let promptDone = false;
  handler.trackPending(3, {
    resolve: () => {
      promptDone = true;
    },
    reject: () => {},
  });

  // Agent terminal ids typically restart at 0 each turn
  for (const agentId of [0, 1, 2, 3]) {
    handler.onLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: agentId,
        method: "terminal/create",
        params: {
          sessionId: "s",
          command: `/bin/bash -lc 'echo tool-${agentId}'`,
          cwd: process.cwd(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 30));
  }

  assert.equal(promptDone, false, "prompt must not resolve on terminal creates");
  assert.equal(handler.hasPending(3), true);

  // All four terminal creates answered
  const termReplies = written.filter(
    (w) => w.result && w.result.terminalId && [0, 1, 2, 3].includes(w.id)
  );
  assert.equal(termReplies.length, 4);

  // id=3 terminal answer is a result with terminalId — NOT empty prompt success
  const id3 = written.find((w) => w.id === 3);
  assert.ok(id3.result.terminalId);
  assert.equal(id3.result.stopReason, undefined);

  await terminals.releaseAll();
});

test("server.mjs wires GrokAcp through AcpLineHandler / classify demux", () => {
  const src = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(src, /AcpLineHandler/);
  assert.match(src, /lineHandler\.onLine/);
  // Multi-agent: runJob uses per-slot `acp` (main still aliased as `agent`)
  assert.match(src, /acp\.stop\(\)|agent\.stop\(\)/);
  // headless path must stop wedged agent, not only start()
  assert.match(src, /stop\(\).*headless|before headless|agent stop before headless/s);
  // Process-group kill for concurrent agents
  assert.match(src, /killProcessTree/);
  assert.match(src, /createAgentRegistry/);
  // Phone agents start at medium reasoning effort
  assert.match(src, /AGENT_REASONING_EFFORT\s*=\s*"medium"/);
  assert.match(src, /--effort[\s\S]*AGENT_REASONING_EFFORT[\s\S]*stdio/);
  assert.match(src, /--effort[\s\S]*AGENT_REASONING_EFFORT[\s\S]*--cwd/);
});
