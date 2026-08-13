import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  openStandup,
  getFeedPayload,
  readLocalStandupSeed,
} from "../lib/standup.mjs";
import {
  formatFeedTime,
  kindLabel,
  combineMenuBadge,
  FIRST_PRINCIPLES_STEPS,
} from "../public/standup-ui.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("standup store seeds welcome post and optional local pins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-standup-"));
  try {
    const store = openStandup(join(dir, "phone-standup.json"), {
      seed: { north_star: "Ship the weekly issue" },
    });
    const feed = getFeedPayload(store);
    assert.equal(feed.pins.north_star, "Ship the weekly issue");
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].kind, "standup");
    assert.equal(feed.unreadCount, 1);
    store.markRead("all");
    assert.equal(store.unreadCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalStandupSeed ignores missing files", () => {
  assert.deepEqual(readLocalStandupSeed("/tmp/does-not-exist-standup-seed.json"), {});
});

test("createPost rejects empty body and unknown kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phone-standup-"));
  try {
    const store = openStandup(join(dir, "feed.json"));
    assert.throws(() => store.createPost({ agentName: "CoS" }), /bodyShort/);
    assert.throws(
      () => store.createPost({ agentName: "CoS", bodyShort: "hi", kind: "tweet" }),
      /kind/
    );
    const post = store.createPost({
      agentName: "Revenue Lead",
      kind: "update",
      bodyShort: "MRR did not move yesterday.",
      bodyLong: "Stripe + RevenueCat both flat. No new paid.",
    });
    assert.equal(post.agentName, "Revenue Lead");
    assert.match(post.bodyShort, /did not move/);
    assert.equal(store.unreadCount(), 2); // welcome + new
    store.markRead([post.id]);
    assert.equal(store.getPost(post.id).readAt != null, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first principles algorithm is shipped in five steps", () => {
  assert.equal(FIRST_PRINCIPLES_STEPS.length, 5);
  assert.match(FIRST_PRINCIPLES_STEPS[0].title, /Question every requirement/i);
  const appJs = readFileSync(join(root, "public/app.js"), "utf8");
  assert.match(appJs, /FIRST_PRINCIPLES_STEPS/);
  assert.doesNotMatch(
    appJs,
    /first_principles_body[\s\S]{0,80}return;/
  );
});

test("formatFeedTime and menu badge combine", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  assert.equal(formatFeedTime("2026-08-13T11:59:30.000Z", now), "now");
  assert.equal(formatFeedTime("2026-08-13T11:40:00.000Z", now), "20m");
  assert.equal(kindLabel("alert"), "Alert");
  assert.equal(combineMenuBadge(1, 2), 3);
  assert.equal(combineMenuBadge(0, 0), 0);
});

test("HTML has standup/jobs/agents/settings pages; drawer is nav only", () => {
  const html = readFileSync(join(root, "public/index.html"), "utf8");
  assert.match(html, /id="page-standup"/);
  assert.match(html, /id="page-principles"/);
  assert.match(html, /id="page-jobs"/);
  assert.match(html, /id="page-agents"/);
  assert.match(html, /id="page-settings"/);
  assert.match(html, /id="nav-standup"/);
  assert.match(html, /id="nav-agents"/);
  assert.match(html, /id="nav-jobs"/);
  assert.match(html, /id="nav-settings"/);
  assert.match(html, /class="glass-btn"/);
  const drawer = html.slice(
    html.indexOf('id="activity-drawer"'),
    html.indexOf("<!-- Full-screen pages")
  );
  assert.doesNotMatch(drawer, /id="activity-jobs"/);
  assert.doesNotMatch(drawer, /id="page-agents-list"/);
  assert.doesNotMatch(drawer, /id="activity-agents"/);
  assert.match(html, /id="page-jobs-list"/);
  assert.match(html, /id="page-agents-list"/);
  const settings = html.slice(html.indexOf('id="page-settings"'));
  assert.match(settings, /id="voice-trigger-input"/);
});

test("public sources do not embed personal standup goals", () => {
  const files = [
    "lib/standup.mjs",
    "lib/loop-report.mjs",
    "lib/briefs.mjs",
    "public/app.js",
    "public/standup-ui.mjs",
    "public/index.html",
    "server.mjs",
    "README.md",
    "examples/phone-loops.example.json",
  ];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(
      text,
      /10k MRR|leftover money/i,
      rel
    );
  }
});

test("server exposes standup API", () => {
  const serverJs = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(serverJs, /\/api\/standup/);
  assert.match(serverJs, /openStandup/);
  assert.match(serverJs, /handleStandupFeed/);
  assert.match(serverJs, /\/api\/briefs/);
  assert.match(serverJs, /runScheduledLoop/);
});
