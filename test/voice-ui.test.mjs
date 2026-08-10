/**
 * Speech-to-text helpers for phone dictation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isMediaRecorderDictationSupported,
  isAnyDictationSupported,
  isSecureDictationContext,
  isAppleMobileSpeech,
  isStandaloneDisplayMode,
  preferServerDictation,
  preferContinuousRecognition,
  pickAudioRecorderMime,
  mergeDictationText,
  consumeRecognitionResults,
  speechRecognitionErrorMessage,
  dictationBlockedReason,
  hasGetUserMedia,
  isNativeAudioFileDictationSupported,
  selectDictationPath,
  buildComposerDraft,
} from "../public/voice-ui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

test("isSpeechRecognitionSupported reflects global ctor", () => {
  assert.equal(isSpeechRecognitionSupported({}), false);
  function FakeRec() {}
  assert.equal(
    isSpeechRecognitionSupported({ SpeechRecognition: FakeRec }),
    true
  );
  assert.equal(
    isSpeechRecognitionSupported({ webkitSpeechRecognition: FakeRec }),
    true
  );
  assert.equal(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeRec }), FakeRec);
});

test("isSecureDictationContext accepts https and localhost", () => {
  assert.equal(
    isSecureDictationContext({ isSecureContext: true, location: {} }),
    true
  );
  assert.equal(
    isSecureDictationContext({ isSecureContext: false, location: {} }),
    false
  );
  assert.equal(
    isSecureDictationContext({
      location: { protocol: "https:", hostname: "example.com" },
    }),
    true
  );
  assert.equal(
    isSecureDictationContext({
      location: { protocol: "http:", hostname: "localhost" },
    }),
    true
  );
  assert.equal(
    isSecureDictationContext({
      location: { protocol: "http:", hostname: "mac.lan" },
    }),
    false
  );
});

test("MediaRecorder path is preferred when Web Speech is missing", () => {
  const g = {
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    MediaRecorder: function MediaRecorder() {},
  };
  g.MediaRecorder.isTypeSupported = () => true;
  assert.equal(isMediaRecorderDictationSupported(g), true);
  assert.equal(isSpeechRecognitionSupported(g), false);
  assert.equal(isAnyDictationSupported(g), true);
  assert.equal(isMediaRecorderDictationSupported({}), false);
});

test("pickAudioRecorderMime prefers supported types", () => {
  const g = {
    MediaRecorder: {
      isTypeSupported: (t) => t.startsWith("audio/mp4"),
    },
  };
  assert.match(pickAudioRecorderMime(g), /^audio\/mp4/);
});

test("iOS prefers non-continuous recognition", () => {
  const ios = {
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
  };
  assert.equal(isAppleMobileSpeech(ios), true);
  assert.equal(preferContinuousRecognition(ios), false);
  const desktop = {
    navigator: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
  };
  assert.equal(isAppleMobileSpeech(desktop), false);
  assert.equal(preferContinuousRecognition(desktop), true);
});

test("mergeDictationText joins base, finals, interim", () => {
  assert.equal(mergeDictationText("", ["hello"], ""), "hello");
  assert.equal(mergeDictationText("Hi", ["there"], ""), "Hi there");
  assert.equal(
    mergeDictationText("Hi", ["there"], "friend"),
    "Hi there friend"
  );
  assert.equal(mergeDictationText("Draft  ", [], "partial"), "Draft partial");
  assert.equal(mergeDictationText("", ["a", "b"], "c"), "a b c");
});

test("consumeRecognitionResults splits final vs interim", () => {
  const event = {
    results: [
      { isFinal: true, 0: { transcript: " one " } },
      { isFinal: true, 0: { transcript: "two" } },
      { isFinal: false, 0: { transcript: " three" } },
    ],
  };
  const a = consumeRecognitionResults(event, 0);
  assert.deepEqual(a.finals, ["one", "two"]);
  assert.equal(a.interim, "three");
  assert.equal(a.nextIndex, 3);

  // Resume from index 2 — only interim
  const b = consumeRecognitionResults(event, 2);
  assert.deepEqual(b.finals, []);
  assert.equal(b.interim, "three");
});

test("speechRecognitionErrorMessage covers permission and network", () => {
  assert.match(speechRecognitionErrorMessage("not-allowed"), /permission/i);
  assert.match(speechRecognitionErrorMessage("network"), /network/i);
  assert.equal(speechRecognitionErrorMessage("aborted"), "");
  assert.match(speechRecognitionErrorMessage("weird"), /weird/);
  assert.match(speechRecognitionErrorMessage("insecure-context"), /HTTPS/i);
});

test("iOS / standalone prefers server (MediaRecorder) dictation", () => {
  const iosPwa = {
    isSecureContext: true,
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
      mediaDevices: { getUserMedia: async () => ({}) },
    },
    MediaRecorder: function MediaRecorder() {},
    matchMedia: () => ({ matches: true }),
  };
  iosPwa.MediaRecorder.isTypeSupported = () => true;
  assert.equal(isAppleMobileSpeech(iosPwa), true);
  assert.equal(isStandaloneDisplayMode(iosPwa), true);
  assert.equal(isSpeechRecognitionSupported(iosPwa), false);
  assert.equal(isMediaRecorderDictationSupported(iosPwa), true);
  assert.equal(preferServerDictation(iosPwa), true);
  assert.equal(dictationBlockedReason(iosPwa), "");
});

test("insecure HTTP allows native voice-memo path (no paid HTTPS required)", () => {
  const lan = {
    isSecureContext: false,
    location: { protocol: "http:", hostname: "mac.lan" },
    document: { createElement: () => ({}) },
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
  };
  assert.equal(isSecureDictationContext(lan), false);
  assert.equal(hasGetUserMedia(lan), false);
  assert.equal(isNativeAudioFileDictationSupported(lan), true);
  // Must not block — file picker works over plain http://
  assert.equal(dictationBlockedReason(lan), "");
  assert.equal(selectDictationPath(lan), "native-audio-file");
});

test("selectDictationPath: iOS PWA secure uses server-media", () => {
  const g = {
    isSecureContext: true,
    document: { createElement: () => ({}) },
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
      mediaDevices: { getUserMedia: async () => ({}) },
    },
    MediaRecorder: function MediaRecorder() {},
    matchMedia: () => ({ matches: true }),
  };
  g.MediaRecorder.isTypeSupported = () => true;
  assert.equal(selectDictationPath(g), "server-media");
});

test("buildComposerDraft merges transcript for review-before-send", () => {
  assert.equal(buildComposerDraft("", "hello world"), "hello world");
  assert.equal(buildComposerDraft("Hi  ", "there"), "Hi there");
  assert.equal(buildComposerDraft("keep", ""), "keep");
  assert.equal(buildComposerDraft("a", "b c"), "a b c");
});

test("desktop with Web Speech does not force server path", () => {
  function FakeRec() {}
  const desktop = {
    isSecureContext: true,
    document: { createElement: () => ({}) },
    navigator: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getUserMedia: async () => ({}) },
    },
    MediaRecorder: function MediaRecorder() {},
    SpeechRecognition: FakeRec,
    matchMedia: () => ({ matches: false }),
  };
  desktop.MediaRecorder.isTypeSupported = () => true;
  assert.equal(preferServerDictation(desktop), false);
  assert.equal(selectDictationPath(desktop), "browser-speech");
});

test("client wires selectDictationPath + native file-audio (structural)", () => {
  const app = readFileSync(join(ROOT, "public/app.js"), "utf8");
  const html = readFileSync(join(ROOT, "public/index.html"), "utf8");
  // Mic entry uses shared path selection (not a reimplemented branch)
  assert.match(app, /selectDictationPath\s*\(/);
  assert.match(app, /path === "native-audio-file"/);
  assert.match(app, /path === "server-media"/);
  assert.match(app, /path === "browser-speech"/);
  assert.match(app, /startNativeAudioFileDictation/);
  assert.match(app, /buildComposerDraft/);
  // Draft only — upload success must not auto-send chat
  assert.match(app, /appendTranscriptToInput/);
  const uploadFn = app.slice(
    app.indexOf("async function uploadDictationBlob"),
    app.indexOf("async function requestMicStream")
  );
  assert.match(uploadFn, /appendTranscriptToInput\(text\)/);
  assert.doesNotMatch(uploadFn, /\/api\/chat/);
  assert.doesNotMatch(uploadFn, /sendMessage\s*\(/);
  // Native picker in HTML (plain http path)
  assert.match(html, /id="file-audio"/);
  assert.match(html, /accept="audio\/\*"/);
  assert.match(html, /id="mic"/);
  // No HTTPS-only hard block for mic init
  assert.match(app, /Always tappable/);
  assert.doesNotMatch(
    app,
    /mic-unsupported.*true|isSecureDictationContext\(\)\s*\&\&\s*!.*return/
  );
});
