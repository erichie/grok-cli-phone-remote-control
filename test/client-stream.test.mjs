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

test("header hosts agent chip; job recovery is in Menu not top bar", () => {
  const html = readFileSync(join(root, "public/index.html"), "utf8");
  // No Get result / Stop & show in the header
  assert.doesNotMatch(html, /id="header-job-actions"/);
  assert.doesNotMatch(html, /id="header-get-result"/);
  assert.doesNotMatch(html, /id="header-stop-show"/);
  assert.match(html, /id="reset-btn"/);
  // Agent chip lives in the top bar (inside <header>)
  const headerEnd = html.indexOf("</header>");
  const chip = html.indexOf('id="agent-chip-bar"');
  assert.ok(chip >= 0 && chip < headerEnd, "agent chip should be inside header");
  assert.match(html, /id="agent-chip"/);
  // Stop & show remains available from the Jobs page
  assert.match(appJs, /Stop & show|finalizeJobFromMenu/);
  assert.match(appJs, /\/finalize/);
  // Per-message job-actions stay non-primary
  assert.match(appJs, /syncJobActions|job-actions/);
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
