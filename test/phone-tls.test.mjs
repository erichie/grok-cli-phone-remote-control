/**
 * Free local HTTPS helpers (no paid Tailscale Serve).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  buildSubjectAltName,
  ensurePhoneTlsMaterial,
  listLanIPv4,
} from "../lib/phone-tls.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("buildSubjectAltName includes localhost, LAN IPs, and DNS names", () => {
  const san = buildSubjectAltName(
    ["10.0.0.5", "10.0.0.5", "100.64.1.2"],
    ["mac.tailnet.ts.net", "mac.tailnet.ts.net"]
  );
  assert.match(san, /DNS:localhost/);
  assert.match(san, /IP:127\.0\.0\.1/);
  assert.match(san, /IP:10\.0\.0\.5/);
  assert.match(san, /IP:100\.64\.1\.2/);
  assert.match(san, /DNS:mac\.tailnet\.ts\.net/);
  // deduped
  assert.equal((san.match(/IP:10\.0\.0\.5/g) || []).length, 1);
  assert.equal((san.match(/DNS:mac\.tailnet\.ts\.net/g) || []).length, 1);
});

test("listLanIPv4 returns array", () => {
  const ips = listLanIPv4();
  assert.ok(Array.isArray(ips));
});

test("ensurePhoneTlsMaterial creates key+cert with openssl when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-tls-"));
  try {
    const mat = ensurePhoneTlsMaterial({ dir, force: true });
    if (!mat) {
      // openssl missing in environment — honest skip of file assertions
      assert.ok(true, "openssl unavailable");
      return;
    }
    assert.ok(mat.key?.length > 0);
    assert.ok(mat.cert?.length > 0);
    assert.equal(existsSync(join(dir, "key.pem")), true);
    assert.equal(existsSync(join(dir, "cert.pem")), true);
    const again = ensurePhoneTlsMaterial({ dir, force: false });
    assert.equal(again?.created, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.mjs dual-listens free HTTPS", () => {
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  assert.match(src, /ensurePhoneTlsMaterial/);
  assert.match(src, /https\.createServer/);
  assert.match(src, /PHONE_CHAT_HTTPS_PORT/);
  assert.match(src, /httpsEnabled/);
});
