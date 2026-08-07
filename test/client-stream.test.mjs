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

test("Get result / Stop & show live in header next to Reset", () => {
  const html = readFileSync(join(root, "public/index.html"), "utf8");
  // Header placement (not only under message bubbles)
  assert.match(html, /id="header-job-actions"/);
  assert.match(html, /id="header-get-result"/);
  assert.match(html, /id="header-stop-show"/);
  assert.match(html, /id="reset-btn"/);
  // Get result appears before Reset in header-right block
  const hr = html.indexOf("header-job-actions");
  const reset = html.indexOf("reset-btn");
  assert.ok(hr >= 0 && reset > hr, "header job actions should sit near Reset");
  assert.match(appJs, /syncHeaderJobActions/);
  assert.match(appJs, /nextHeaderJobVisibility/);
  assert.match(appJs, /headerGetResult|header-get-result/);
  assert.match(appJs, /\/finalize/);
  // Per-message job-actions are no longer the primary wire path
  assert.match(appJs, /Primary recovery UI: header|header-job-actions|syncHeaderJobActions/);
  // Reset and job-404 must clear header recovery (stuck-button bugs)
  assert.match(appJs, /clearHeaderJobActions/);
  assert.match(
    appJs,
    /res\.status === 404[\s\S]{0,400}syncHeaderJobActions\(jobId,\s*["']error["']\)/
  );
  assert.match(
    appJs,
    /clearHeaderJobActions\(\)|function resetAgent[\s\S]{0,800}clearHeaderJobActions/
  );
});

test("thinking UI uses shared breathing/dots markup builder", () => {
  assert.match(appJs, /buildThinkingHtml/);
  assert.match(appJs, /thinking-ui\.mjs/);
  assert.match(appJs, /thinking-live|think-breathe/);
  // Reply stream is appended before thinking (thinking below response)
  const addMsgStart = appJs.indexOf("function addMsg");
  const bodyChunk = appJs.slice(addMsgStart, addMsgStart + 2500);
  const bodyPos = bodyChunk.indexOf('body.className = "body"');
  const thinkPos = bodyChunk.indexOf('thinkingEl.className = "thinking"');
  assert.ok(bodyPos >= 0 && thinkPos > bodyPos, "body before thinking in addMsg");
  const css = readFileSync(join(root, "public/styles.css"), "utf8");
  assert.match(css, /think-breathe|think-label-shimmer/);
  assert.match(css, /think-dot-pulse|think-dots/);
  // No card background on thinking block
  assert.match(css, /\.msg \.thinking\.thinking-live[\s\S]{0,80}background:\s*none/);
});

test("client reloads host-backed conversation on unlock (not localStorage-only)", () => {
  assert.match(appJs, /\/api\/conversation/);
  assert.match(appJs, /loadHostConversation/);
  assert.match(appJs, /mergeHostHistory/);
  assert.match(appJs, /ensureActiveJobBotMessages/);
  assert.match(appJs, /history-merge\.mjs/);
  assert.match(appJs, /reattachActiveJobs/);
  assert.match(appJs, /\.msg\.bot\[data-job-id/);
  // showChat awaits host history before render
  assert.match(appJs, /await loadHostConversation|loadHostConversation\(\)/);
  assert.match(serverJs, /handleConversation|\/api\/conversation/);
  assert.match(serverJs, /session\/load/);
  assert.match(serverJs, /preferredSessionId|phone-conversation/);
});
