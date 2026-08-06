#!/usr/bin/env node
/**
 * Fail if tracked-looking source files contain machine-specific paths or secret patterns.
 * Run: node scripts/check-no-local-leaks.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "scratch",
  "tmp",
  "coverage",
]);

const TEXT_EXT = new Set([
  ".md",
  ".mjs",
  ".js",
  ".json",
  ".html",
  ".css",
  ".example",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".svg",
  ".webmanifest",
]);

// Patterns that must not appear in published sources (real machine leakage).
const FORBIDDEN = [
  { name: "absolute_Users_home", re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "absolute_Volumes", re: /\/Volumes\/[A-Za-z0-9._-]+\// },
  { name: "private_home_abs", re: /\/home\/[A-Za-z0-9._-]+\// },
  { name: "lan_ip", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { name: "phone_secret_assignment", re: /PHONE_CHAT_SECRET\s*=\s*['"][a-f0-9]{16,}/i },
  { name: "long_hex_secret_literal", re: /['"`][a-f0-9]{40,}['"`]/ },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") && name !== ".env.example" && name !== ".gitignore") {
      if (name === ".git") continue;
    }
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function isText(path) {
  const base = path.split("/").pop() || "";
  if (base === "LICENSE" || base === "README.md" || base === ".gitignore") return true;
  if (base.endsWith(".plist.example")) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXT.has(base.slice(dot));
}

const files = walk(root).filter(isText);
const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // skip this script's own pattern definitions source lines carefully — still scan
  for (const { name, re } of FORBIDDEN) {
    if (re.test(text)) {
      // Allow the checker itself to contain the regex source
      if (file.endsWith("check-no-local-leaks.mjs")) continue;
      if (file.endsWith("no-local-leaks.test.mjs")) continue;
      hits.push({ file: relative(root, file), rule: name });
    }
  }
}

if (hits.length) {
  console.error("Local leakage patterns found:");
  for (const h of hits) console.error(`  [${h.rule}] ${h.file}`);
  process.exit(1);
}

console.log(`OK: scanned ${files.length} text files, no local leakage patterns.`);
