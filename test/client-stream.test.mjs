/**
 * Structural + unit checks that the phone client uses live push (SSE)
 * and applies progressive job snapshots (not poll-only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appJs = readFileSync(join(root, "public/app.js"), "utf8");
const serverJs = readFileSync(join(root, "server.mjs"), "utf8");

test("client subscribes to SSE job stream (not poll-only)", () => {
  assert.match(appJs, /EventSource/);
  assert.match(appJs, /\/api\/jobs\/.*\/stream/);
  assert.match(appJs, /addEventListener\(\s*["']job["']/);
  // progressive apply path
  assert.match(appJs, /applyJobToUi|const applyJobToUi/);
  assert.match(appJs, /job\.reply/);
  assert.match(appJs, /job\.thought|setThinking/);
  assert.match(appJs, /job\.tools/);
});

test("server exposes SSE stream endpoint and notifies on persist", () => {
  assert.match(serverJs, /\/api\/jobs\/.*\/stream/);
  assert.match(serverJs, /text\/event-stream/);
  assert.match(serverJs, /notifyJobSubscribers/);
  assert.match(serverJs, /event: job/);
  // progressive ingest uses shared applySessionUpdate
  assert.match(serverJs, /applySessionUpdate/);
  // agent→client terminal handling (root hang fix)
  assert.match(serverJs, /AcpLineHandler|terminal\/create/);
  assert.match(serverJs, /lineHandler\.onLine|_onLine/);
  assert.match(serverJs, /TerminalManager/);
});

test("Get result / Stop & show recovery buttons present", () => {
  assert.match(appJs, /Get result/);
  assert.match(appJs, /Stop & show/);
  assert.match(appJs, /\/finalize/);
});
