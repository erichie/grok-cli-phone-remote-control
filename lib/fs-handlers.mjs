/**
 * ACP fs/read_text_file and fs/write_text_file for the phone bridge client.
 */
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, join, basename, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * Resolve a path, expanding symlinks for every existing ancestor.
 * Non-existent leaf components are appended after realpath of the parent
 * so a symlink under an allowed root cannot escape to /etc, etc.
 *
 * @param {string} path
 * @returns {string}
 */
export function resolvePathSafe(path) {
  const abs = resolve(path);
  const missing = [];
  let cur = abs;
  // Walk up until we find an existing node (or hit filesystem root).
  for (;;) {
    try {
      if (existsSync(cur)) {
        const real = realpathSync(cur);
        if (!missing.length) return real;
        return join(real, ...missing.reverse());
      }
    } catch {
      /* fall through and walk up */
    }
    const parent = dirname(cur);
    if (parent === cur) {
      // Nothing existed; return the absolute path as-is.
      return abs;
    }
    missing.push(basename(cur));
    cur = parent;
  }
}

/**
 * @param {string} path
 * @param {string[]} allowedRoots
 */
export function isPathAllowed(path, allowedRoots) {
  if (!path || typeof path !== "string") return false;
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) return false;
  let resolved;
  try {
    resolved = resolvePathSafe(path);
  } catch {
    return false;
  }
  // Normalize roots the same way (existing dirs → realpath).
  return allowedRoots.some((root) => {
    let r;
    try {
      r = resolvePathSafe(root);
    } catch {
      r = resolve(root);
    }
    return resolved === r || resolved.startsWith(r + sep);
  });
}

/**
 * Default allowed roots for phone bridge ACP file ops.
 *
 * By default this is **narrow**: workspace cwd, system temp, and `~/.grok`.
 * Full home is opt-in via `allowHome` (env `PHONE_CHAT_ALLOW_HOME=1`).
 *
 * @param {string} cwd
 * @param {{ allowHome?: boolean, extraRoots?: string[] }} [options]
 */
export function defaultAllowedRoots(cwd, options = {}) {
  const roots = [
    resolve(cwd),
    resolve(tmpdir()),
    resolve(homedir(), ".grok"),
  ];
  if (options.allowHome) {
    roots.push(resolve(homedir()));
  }
  if (Array.isArray(options.extraRoots)) {
    for (const r of options.extraRoots) {
      if (r && typeof r === "string") roots.push(resolve(r));
    }
  }
  // Dedup + realpath existing roots so comparisons match resolvePathSafe.
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    let key;
    try {
      key = existsSync(r) ? realpathSync(r) : r;
    } catch {
      key = r;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * @param {{ path: string, line?: number|null, limit?: number|null }} params
 * @param {string[]} allowedRoots
 * @returns {Promise<{ content: string }>}
 */
export async function readTextFile(params, allowedRoots) {
  const path = params?.path;
  if (!path) {
    throw Object.assign(new Error("fs/read_text_file requires path"), {
      code: -32602,
    });
  }
  if (!isPathAllowed(path, allowedRoots)) {
    throw Object.assign(new Error(`path not allowed: ${path}`), {
      code: -32602,
    });
  }
  const abs = resolvePathSafe(path);
  // Reject if path is a symlink that escaped (defense in depth after resolvePathSafe).
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      const real = await realpath(abs);
      if (!isPathAllowed(real, allowedRoots)) {
        throw Object.assign(new Error(`path not allowed: ${path}`), {
          code: -32602,
        });
      }
    }
  } catch (e) {
    if (e && e.code === -32602) throw e;
    /* file may not exist yet / race — readFile will throw */
  }
  const raw = await readFile(abs, "utf8");
  const lines = raw.split("\n");
  let start = 0;
  if (params.line != null && Number(params.line) > 0) {
    start = Math.max(0, Number(params.line) - 1);
  }
  let slice = lines.slice(start);
  if (params.limit != null && Number(params.limit) >= 0) {
    slice = slice.slice(0, Number(params.limit));
  }
  return { content: slice.join("\n") };
}

/**
 * @param {{ path: string, content: string }} params
 * @param {string[]} allowedRoots
 * @returns {Promise<object>}
 */
export async function writeTextFile(params, allowedRoots) {
  const path = params?.path;
  if (!path) {
    throw Object.assign(new Error("fs/write_text_file requires path"), {
      code: -32602,
    });
  }
  if (typeof params.content !== "string") {
    throw Object.assign(new Error("fs/write_text_file requires content"), {
      code: -32602,
    });
  }
  if (!isPathAllowed(path, allowedRoots)) {
    throw Object.assign(new Error(`path not allowed: ${path}`), {
      code: -32602,
    });
  }
  const abs = resolvePathSafe(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, params.content, "utf8");
  return {};
}
