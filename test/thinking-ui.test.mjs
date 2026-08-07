/**
 * Shipped thinking markup (public/thinking-ui.mjs) — same path setThinking uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildThinkingHtml,
  shouldShowJobRecovery,
  nextHeaderJobVisibility,
  escapeHtml,
} from "../public/thinking-ui.mjs";

test("buildThinkingHtml includes breathing + dots animation hooks", () => {
  const html = buildThinkingHtml({
    phase: "Thinking…",
    tools: "read_file (running)",
    thought: "planning next step",
  });
  assert.match(html, /think-breathe/);
  assert.match(html, /think-dots/);
  assert.match(html, /think-dot/);
  assert.match(html, /think-row/);
  assert.match(html, /Thinking/);
  // No double ellipsis on the label — animated dots are the only "..."
  assert.doesNotMatch(html, /think-breathe[^>]*>Thinking…/);
  assert.doesNotMatch(html, /think-breathe[^>]*>Thinking\.\.\./);
  assert.match(html, /read_file/);
  assert.match(html, /planning next step/);
  // three dots
  assert.equal((html.match(/class="think-dot"/g) || []).length, 3);
});

test("buildThinkingHtml strips trailing ellipsis from phase", () => {
  const html = buildThinkingHtml({ phase: "Working..." });
  assert.match(html, />Working</);
  assert.doesNotMatch(html, />Working\.\.\.</);
});

test("buildThinkingHtml escapes user-controlled phase/tools/thought", () => {
  const html = buildThinkingHtml({
    phase: `<script>x</script>`,
    tools: `a & b`,
    thought: `">xss`,
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

test("shouldShowJobRecovery only for non-terminal statuses", () => {
  assert.equal(shouldShowJobRecovery("running"), true);
  assert.equal(shouldShowJobRecovery("queued"), true);
  assert.equal(shouldShowJobRecovery("done"), false);
  assert.equal(shouldShowJobRecovery("error"), false);
  assert.equal(shouldShowJobRecovery("cancelled"), false);
  assert.equal(shouldShowJobRecovery(null), false);
});

test("escapeHtml is the shared helper used by thinking markup", () => {
  assert.equal(escapeHtml(`a<b>"c"`), "a&lt;b&gt;&quot;c&quot;");
});

test("nextHeaderJobVisibility hides on job 404/error (dead job)", () => {
  // Was showing job-a as running
  const after404 = nextHeaderJobVisibility("job-a", "job-a", "error");
  assert.equal(after404.visible, false);
  assert.equal(after404.activeJobId, null);

  const afterDone = nextHeaderJobVisibility("job-a", "job-a", "done");
  assert.equal(afterDone.visible, false);
});

test("nextHeaderJobVisibility hides on Reset clear-all", () => {
  const afterReset = nextHeaderJobVisibility("job-stuck", null, "cancelled");
  assert.equal(afterReset.visible, false);
  assert.equal(afterReset.activeJobId, null);
});

test("nextHeaderJobVisibility keeps other active job if a different job ends", () => {
  const next = nextHeaderJobVisibility("job-active", "job-old", "done");
  assert.equal(next.visible, true);
  assert.equal(next.activeJobId, "job-active");
});
