/**
 * ACP fs/read_text_file and fs/write_text_file for the phone bridge client.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * @param {string} path
 * @param {string[]} allowedRoots
 */
export function isPathAllowed(path, allowedRoots) {
  if (!path || typeof path !== "string") return false;
  let resolved;
  try {
    resolved = resolve(path);
  } catch {
    return false;
  }
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + "/")
  );
}

/**
 * Default allowed roots for phone bridge file ops.
 * @param {string} cwd
 */
export function defaultAllowedRoots(cwd) {
  return [
    resolve(cwd),
    resolve(homedir()),
    resolve(tmpdir()),
    resolve(homedir(), ".grok"),
  ];
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
  const raw = await readFile(resolve(path), "utf8");
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
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, params.content, "utf8");
  return {};
}
