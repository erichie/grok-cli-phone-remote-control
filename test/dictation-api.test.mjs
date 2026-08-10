/**
 * Mac dictation pipeline + POST contract (lib/dictation.mjs — same as server).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  extensionFromContentType,
  processDictationAudio,
  normalizeDictationSuccess,
} from "../lib/dictation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH =
  process.env.GROK_GOAL_SCRATCH ||
  join(__dirname, "..", ".scratch-dictation-test");

test("extensionFromContentType maps phone formats", () => {
  assert.equal(extensionFromContentType("audio/mp4"), "m4a");
  assert.equal(extensionFromContentType("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionFromContentType("audio/wav"), "wav");
  assert.equal(extensionFromContentType("audio/mpeg"), "mp3");
});

test("normalizeDictationSuccess rejects empty text", () => {
  assert.throws(
    () => normalizeDictationSuccess({ text: "  ", engine: "x" }),
    (e) => e.code === "EMPTY_TRANSCRIPT"
  );
  const ok = normalizeDictationSuccess({ text: " hello ", engine: "custom" });
  assert.equal(ok.text, "hello");
  assert.equal(ok.engine, "custom");
});

test("processDictationAudio empty buffer is EMPTY_AUDIO", async () => {
  await assert.rejects(
    () =>
      processDictationAudio(Buffer.alloc(0), {
        workDir: join(SCRATCH, "empty"),
        skipMacosSpeech: true,
        whisperBin: null,
        sttCmd: "",
      }),
    (e) => e.code === "EMPTY_AUDIO"
  );
});

test("processDictationAudio with custom STT cmd returns text (success path)", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  // Minimal valid-ish wav via ffmpeg if present; else tiny buffer + sttCmd that ignores file content
  const workDir = join(SCRATCH, "stt-ok");
  mkdirSync(workDir, { recursive: true });
  let audio = Buffer.from("not-really-audio");
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ff.status === 0) {
    const wav = join(workDir, "seed.wav");
    const gen = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-ac",
        "1",
        "-ar",
        "16000",
        wav,
      ],
      { encoding: "utf8" }
    );
    if (gen.status === 0 && existsSync(wav)) {
      audio = readFileSync(wav);
    }
  }

  // Custom STT always succeeds with fixed phrase — exercises real processDictationAudio
  // (ffmpeg may fail on garbage; sttCmd can echo without reading file)
  const result = await processDictationAudio(audio, {
    contentType: "audio/wav",
    locale: "en-US",
    workDir,
    skipMacosSpeech: true,
    whisperBin: null,
    // If convert fails we still need a path — use stt that runs after convert
    // Provide a cmd that always prints transcript (file placeholder unused for content)
    sttCmd: 'printf "%s" "hello from dictation test"',
  });

  const payload = normalizeDictationSuccess(result);
  assert.equal(payload.text, "hello from dictation test");
  assert.equal(payload.engine, "custom");
});

test("processDictationAudio surfaces clear error when no STT backend", async () => {
  const workDir = join(SCRATCH, "no-stt");
  mkdirSync(workDir, { recursive: true });
  // Pre-made silent wav so convert can skip/fail gracefully
  const wav = join(workDir, "in.wav");
  const gen = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "0.15",
      wav,
    ],
    { encoding: "utf8" }
  );
  if (gen.status !== 0) {
    // Still assert empty/backend error path with custom empty cmd
    await assert.rejects(
      () =>
        processDictationAudio(Buffer.from("x"), {
          contentType: "audio/wav",
          workDir,
          skipMacosSpeech: true,
          whisperBin: null,
          sttCmd: "exit 1",
        }),
      /PHONE_CHAT_STT_CMD failed|ffmpeg|Could not transcribe|No speech-to-text/
    );
    return;
  }
  const audio = readFileSync(wav);
  await assert.rejects(
    () =>
      processDictationAudio(audio, {
        contentType: "audio/wav",
        workDir,
        skipMacosSpeech: true,
        whisperBin: null,
        sttCmd: "", // no custom, skip macos, no whisper
      }),
    /Could not transcribe|No speech-to-text/
  );
});

test("server.mjs wires POST /api/dictation to processDictationAudio", () => {
  const src = readFileSync(join(__dirname, "..", "server.mjs"), "utf8");
  assert.match(src, /pathOnly === "\/api\/dictation"/);
  assert.match(src, /processDictationAudio/);
  assert.match(src, /normalizeDictationSuccess/);
  assert.match(src, /handleDictation/);
});
