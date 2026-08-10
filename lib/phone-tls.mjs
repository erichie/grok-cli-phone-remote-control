/**
 * Free local HTTPS for phone PWA (self-signed).
 * No paid Tailscale Serve — openssl once, dual-listen with HTTP.
 * SAN covers LAN IPs, Tailscale 100.x IPs, hostname, and MagicDNS names when known.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * @returns {string[]} IPv4 addresses suitable for SAN (LAN + Tailscale CGNAT)
 */
export function listLanIPv4() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets || {})) {
    for (const net of nets[name] || []) {
      const fam = net.family;
      const v4 = fam === "IPv4" || fam === 4;
      if (!v4 || net.internal) continue;
      if (net.address) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

/**
 * Extra DNS names: host short name, FQDN-ish hostname, env list, Tailscale MagicDNS.
 * @returns {string[]}
 */
export function listTlsDnsNames() {
  const names = new Set();
  const add = (n) => {
    const s = String(n || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (!s || s === "localhost") return;
    // bare hostname or dotted MagicDNS
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s)) names.add(s);
  };

  try {
    add(hostname());
    const short = hostname().split(".")[0];
    add(short);
  } catch {
    /* ignore */
  }

  const envHosts = (process.env.PHONE_CHAT_TLS_HOSTS || "")
    .split(/[,\s]+/)
    .filter(Boolean);
  for (const h of envHosts) add(h);

  // Tailscale MagicDNS (free): DNSName like "mac.tailnet-name.ts.net"
  try {
    const r = spawnSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout) {
      const j = JSON.parse(r.stdout);
      if (j.Self?.DNSName) add(j.Self.DNSName);
      if (j.Self?.HostName) add(j.Self.HostName);
      // Also IPs via status (listLanIPv4 already has utun)
      for (const ip of j.Self?.TailscaleIPs || []) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          /* IPs handled separately */
        }
      }
    }
  } catch {
    /* tailscale not installed or not up */
  }

  return [...names];
}

/**
 * Build OpenSSL SAN string for localhost + IPs + DNS (MagicDNS etc.).
 * @param {string[]} [ips]
 * @param {string[]} [dnsNames]
 */
export function buildSubjectAltName(
  ips = listLanIPv4(),
  dnsNames = listTlsDnsNames()
) {
  const parts = ["DNS:localhost", "IP:127.0.0.1", "IP:0:0:0:0:0:0:0:1"];
  const seen = new Set(parts);
  for (const ip of [...new Set(ips || [])]) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const entry = `IP:${ip}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    parts.push(entry);
  }
  for (const name of [...new Set(dnsNames || [])]) {
    const entry = `DNS:${name}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    parts.push(entry);
  }
  return parts.join(",");
}

/**
 * Ensure key+cert exist (create with openssl if missing or SAN stale).
 * @param {{ dir: string, force?: boolean }} opts
 * @returns {{ key: Buffer, cert: Buffer, dir: string, created: boolean, san: string } | null}
 */
export function ensurePhoneTlsMaterial(opts) {
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const sanPath = join(dir, "san.txt");
  const san = buildSubjectAltName();

  const sanUnchanged =
    existsSync(sanPath) &&
    readFileSync(sanPath, "utf8").trim() === san.trim();

  if (
    !opts.force &&
    existsSync(keyPath) &&
    existsSync(certPath) &&
    sanUnchanged
  ) {
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
      dir,
      created: false,
      san,
    };
  }

  // openssl free; no cloud CA
  const conf = [
    "[req]",
    "distinguished_name=req_distinguished_name",
    "x509_extensions=v3_req",
    "prompt=no",
    "[req_distinguished_name]",
    "CN=grok-phone-pwa",
    "O=Grok Phone Local",
    "[v3_req]",
    "keyUsage=digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${san}`,
  ].join("\n");
  const confPath = join(dir, "openssl.cnf");
  writeFileSync(confPath, conf, "utf8");

  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "825",
      "-config",
      confPath,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0 || !existsSync(keyPath) || !existsSync(certPath)) {
    console.warn(
      "[tls] openssl failed — HTTPS live mic disabled:",
      (r.stderr || r.stdout || "").slice(0, 200)
    );
    return null;
  }
  writeFileSync(sanPath, san + "\n", "utf8");
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    dir,
    created: true,
    san,
  };
}
