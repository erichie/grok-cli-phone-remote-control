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

test("README documents free local HTTPS live mic (no paid Serve)", () => {
  assert.match(readme, /Live mic: free local HTTPS|free local HTTPS/i);
  assert.match(readme, /8788/);
  assert.match(readme, /self-signed/i);
  assert.match(readme, /PHONE_CHAT_HTTPS_PORT/);
  assert.match(readme, /bee boop/i);
  assert.match(readme, /Tailscale/i);
  assert.match(readme, /Certificate Trust|trust/i);
  assert.match(readme, /phone-remote-control|Voice send/i);
});

test("project skill phone-remote-control exists with HTTPS setup", () => {
  const skill = readFileSync(
    join(root, ".grok/skills/phone-remote-control/SKILL.md"),
    "utf8"
  );
  assert.match(skill, /^name:\s*phone-remote-control/m);
  assert.match(skill, /8788/);
  assert.match(skill, /self-signed|free local HTTPS|PHONE_CHAT_HTTPS/i);
  assert.match(skill, /bee boop/i);
  assert.match(skill, /Add to Home Screen/i);
});
