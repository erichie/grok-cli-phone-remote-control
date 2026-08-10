/**
 * Mac-side phone dictation: convert audio + STT backends.
 * Extracted for unit tests (same code the HTTP handler uses).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MACOS_TRANSCRIBE_SWIFT = join(
  __dirname,
  "..",
  "scripts",
  "macos-transcribe.swift"
);

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd?: string, env?: object, timeoutMs?: number }} [opts]
 */
export function runCmdCapture(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`timeout running ${bin}`));
    }, opts.timeoutMs || 90_000);
    proc.stdout?.on("data", (c) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", (c) => {
      err += c.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

export async function whichBin(name) {
  try {
    const r = await runCmdCapture("/usr/bin/which", [name], { timeoutMs: 3000 });
    if (r.code === 0 && r.out.trim()) return r.out.trim().split("\n")[0];
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} contentType
 * @returns {string} file extension without dot
 */
export function extensionFromContentType(contentType) {
  const ctype = String(contentType || "").toLowerCase();
  if (ctype.includes("mp4") || ctype.includes("m4a") || ctype.includes("aac")) {
    return "m4a";
  }
  if (ctype.includes("wav")) return "wav";
  if (ctype.includes("ogg")) return "ogg";
  if (ctype.includes("mpeg") || ctype.includes("mp3")) return "mp3";
  if (ctype.includes("caf")) return "caf";
  if (ctype.includes("webm")) return "webm";
  return "webm";
}

/**
 * @param {string} inputPath
 * @param {string} wavPath
 * @param {{ ffmpegBin?: string, cwd?: string }} [opts]
 */
export async function convertAudioToWav(inputPath, wavPath, opts = {}) {
  const ffmpeg =
    opts.ffmpegBin ||
    process.env.PHONE_CHAT_FFMPEG ||
    (await whichBin("ffmpeg")) ||
    "ffmpeg";
  const r = await runCmdCapture(
    ffmpeg,
    [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ],
    { timeoutMs: 60_000, cwd: opts.cwd }
  );
  if (r.code !== 0 || !existsSync(wavPath)) {
    throw new Error(
      `ffmpeg convert failed: ${(r.err || r.out || "").slice(0, 240)}`
    );
  }
}

/**
 * @param {string} wavPath
 * @param {string} [locale]
 * @param {{
 *   workDir: string,
 *   swiftScript?: string,
 *   cwd?: string,
 *   sttCmd?: string,
 *   whisperBin?: string|null,
 *   skipMacosSpeech?: boolean,
 * }} opts
 * @returns {Promise<{ text: string, engine: string }>}
 */
export async function transcribeWav(wavPath, locale, opts) {
  const lang = (locale || "en-US").trim() || "en-US";
  const workDir = opts.workDir;

  const custom = String(
    opts.sttCmd !== undefined ? opts.sttCmd : process.env.PHONE_CHAT_STT_CMD || ""
  ).trim();
  if (custom) {
    const shell = custom
      .replaceAll("{file}", wavPath)
      .replaceAll("{locale}", lang);
    const r = await runCmdCapture("/bin/sh", ["-c", shell], {
      timeoutMs: 120_000,
      cwd: opts.cwd,
    });
    if (r.code === 0 && r.out.trim()) {
      return { text: r.out.trim(), engine: "custom" };
    }
    throw new Error(
      `PHONE_CHAT_STT_CMD failed: ${(r.err || r.out || "no output").slice(0, 240)}`
    );
  }

  const swiftScript =
    opts.swiftScript ||
    process.env.PHONE_CHAT_MACOS_TRANSCRIBE ||
    DEFAULT_MACOS_TRANSCRIBE_SWIFT;

  if (
    !opts.skipMacosSpeech &&
    process.platform === "darwin" &&
    existsSync(swiftScript)
  ) {
    const swift = (await whichBin("swift")) || "swift";
    const r = await runCmdCapture(swift, [swiftScript, wavPath, lang], {
      timeoutMs: 90_000,
      cwd: opts.cwd,
    });
    if (r.code === 0 && r.out.trim()) {
      return { text: r.out.trim(), engine: "macos-speech" };
    }
  }

  const whisper =
    opts.whisperBin !== undefined
      ? opts.whisperBin
      : process.env.PHONE_CHAT_WHISPER_BIN || (await whichBin("whisper")) || null;
  if (whisper) {
    const outDir = join(workDir, `wout-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    try {
      const r = await runCmdCapture(
        whisper,
        [
          wavPath,
          "--model",
          process.env.PHONE_CHAT_WHISPER_MODEL || "base",
          "--language",
          lang.slice(0, 2),
          "--output_format",
          "txt",
          "--output_dir",
          outDir,
        ],
        { timeoutMs: 180_000, cwd: opts.cwd }
      );
      if (r.code === 0) {
        const names = await readdir(outDir);
        const txt = names.find((n) => n.endsWith(".txt"));
        if (txt) {
          const text = (await readFile(join(outDir, txt), "utf8")).trim();
          if (text) return { text, engine: "whisper" };
        }
      }
      throw new Error((r.err || r.out || "whisper failed").slice(0, 240));
    } finally {
      try {
        const names = await readdir(outDir);
        for (const n of names) await unlink(join(outDir, n)).catch(() => {});
        await runCmdCapture("/bin/rm", ["-rf", outDir], {
          timeoutMs: 5000,
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(
    process.platform === "darwin"
      ? "Could not transcribe. Allow Speech Recognition for Terminal/node (System Settings → Privacy & Security), or install whisper / set PHONE_CHAT_STT_CMD."
      : "No speech-to-text backend. Install whisper or set PHONE_CHAT_STT_CMD='your-cmd {file}'."
  );
}

/**
 * Full dictation pipeline used by POST /api/dictation.
 * @param {Buffer|Uint8Array} buf
 * @param {{
 *   contentType?: string,
 *   locale?: string,
 *   workDir: string,
 *   sttCmd?: string,
 *   skipMacosSpeech?: boolean,
 *   whisperBin?: string|null,
 *   swiftScript?: string,
 *   ffmpegBin?: string,
 *   cwd?: string,
 * }} opts
 * @returns {Promise<{ text: string, engine: string }>}
 */
export async function processDictationAudio(buf, opts) {
  if (!buf || !buf.length) {
    const err = new Error("empty audio");
    err.code = "EMPTY_AUDIO";
    throw err;
  }
  const workDir = opts.workDir;
  await mkdir(workDir, { recursive: true });
  const ext = extensionFromContentType(opts.contentType);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const rawPath = join(workDir, `${id}.${ext}`);
  const wavPath = join(workDir, `${id}.wav`);

  try {
    await writeFile(rawPath, buf);
    if (ext === "wav") {
      try {
        await convertAudioToWav(rawPath, wavPath, {
          ffmpegBin: opts.ffmpegBin,
          cwd: opts.cwd,
        });
      } catch {
        await writeFile(wavPath, buf);
      }
    } else {
      await convertAudioToWav(rawPath, wavPath, {
        ffmpegBin: opts.ffmpegBin,
        cwd: opts.cwd,
      });
    }
    return await transcribeWav(wavPath, opts.locale || "en-US", {
      workDir,
      sttCmd: opts.sttCmd,
      skipMacosSpeech: opts.skipMacosSpeech,
      whisperBin: opts.whisperBin,
      swiftScript: opts.swiftScript,
      cwd: opts.cwd,
    });
  } finally {
    await unlink(rawPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}

/**
 * Normalize STT success payload — never empty text on ok.
 * @param {{ text?: string, engine?: string }} result
 */
export function normalizeDictationSuccess(result) {
  const text = String(result?.text || "").trim();
  if (!text) {
    const err = new Error("empty transcript");
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }
  return { text, engine: result.engine || "unknown" };
}
