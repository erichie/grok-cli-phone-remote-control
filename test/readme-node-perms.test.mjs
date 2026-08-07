/**
 * README must document first-run macOS Node filesystem permission prompts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("README documents first-run macOS Node filesystem permissions", () => {
  assert.match(readme, /macOS/i);
  assert.match(readme, /\bnode\b|Node\.js|Node/i);
  assert.match(readme, /permission|Privacy & Security|Files and Folders/i);
  assert.match(readme, /[Ff]irst[- ]run|first times|first time/i);
  assert.match(readme, /filesystem|folder|workspace|Full Disk Access/i);
});
