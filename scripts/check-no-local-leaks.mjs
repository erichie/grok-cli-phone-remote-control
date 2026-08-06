#!/usr/bin/env node
/**
 * Fail if published sources or git history contain machine-specific paths,
 * personal emails, or secret patterns.
 * Run: node scripts/check-no-local-leaks.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  // Personal mailboxes / machine labels (use GitHub noreply in commits)
  { name: "personal_gmail", re: /\b[A-Za-z0-9._%+-]+@gmail\.com\b/i },
  { name: "personal_icloud", re: /\b[A-Za-z0-9._%+-]+@icloud\.com\b/i },
  { name: "launchagent_personal", re: /com\.(edward|eric)\./i },
  { name: "lexar_volume", re: /\bLexar\b/ },
  { name: "post_tracker_product", re: /\bpost-tracker\b/i },
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
  for (const { name, re } of FORBIDDEN) {
    if (re.test(text)) {
      if (file.endsWith("check-no-local-leaks.mjs")) continue;
      if (file.endsWith("no-local-leaks.test.mjs")) continue;
      hits.push({ file: relative(root, file), rule: name });
    }
  }
}

// Git history: author/committer must not be personal mailboxes.
if (existsSync(join(root, ".git"))) {
  const log = spawnSync(
    "git",
    ["log", "--format=%ae%n%ce", "--all"],
    { cwd: root, encoding: "utf8" }
  );
  if (log.status === 0 && log.stdout) {
    const emails = new Set(
      log.stdout
        .split("\n")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    const badEmail = /@(gmail|icloud|me|mac|yahoo|hotmail|outlook)\.com$/i;
    for (const email of emails) {
      if (badEmail.test(email)) {
        hits.push({
          file: "git-history",
          rule: `commit_email:${email}`,
        });
      }
    }
  }
}

if (hits.length) {
  console.error("Local leakage patterns found:");
  for (const h of hits) console.error(`  [${h.rule}] ${h.file}`);
  process.exit(1);
}

console.log(`OK: scanned ${files.length} text files, no local leakage patterns.`);
