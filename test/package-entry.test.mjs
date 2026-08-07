/**
 * Structural checks for the published package entrypoints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json start script points at server.mjs", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node server.mjs");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.engines?.node);
});

test("PWA public assets exist", () => {
  for (const f of [
    "public/index.html",
    "public/app.js",
    "public/history-merge.mjs",
    "public/thinking-ui.mjs",
    "public/styles.css",
    "public/sw.js",
    "public/manifest.webmanifest",
    "server.mjs",
    "LICENSE",
    ".gitignore",
    ".env.example",
  ]) {
    assert.ok(existsSync(join(root, f)), `missing ${f}`);
  }
});

test("server requires PHONE_CHAT_SECRET (shipped guard)", () => {
  const src = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(src, /PHONE_CHAT_SECRET/);
  assert.match(src, /process\.exit\(1\)/);
  assert.match(src, /grok agent/);
});
