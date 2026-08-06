/**
 * Drives the real leak-check script shipped with the repo.
 * Fails if published sources contain machine-specific paths or secret literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "check-no-local-leaks.mjs");

test("check-no-local-leaks exits 0 on this tree", () => {
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    r.status,
    0,
    `leak check failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`
  );
  assert.match(r.stdout, /OK: scanned \d+ text files/);
});

test("README documents required secret and start command without absolute machine paths", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.match(readme, /PHONE_CHAT_SECRET/);
  assert.match(readme, /npm start/);
  assert.match(readme, /grok login|Grok CLI/i);
  assert.doesNotMatch(readme, /\/Volumes\//);
  assert.doesNotMatch(readme, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.doesNotMatch(readme, /192\.168\.\d+\.\d+/);
});
