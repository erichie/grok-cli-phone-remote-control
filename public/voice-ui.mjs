/**
 * Pure helpers for phone dictation.
 * Paths: (1) MediaRecorder → Mac STT (iOS PWA / when Web Speech missing)
 *        (2) Web Speech API (desktop Chrome, some Safari tabs)
 *
 * Important: iOS Safari and home-screen PWAs do NOT expose
 * webkitSpeechRecognition, even on modern iOS. That is not a version gap —
 * the API simply isn't there. Mic permission only appears when we call
 * getUserMedia (MediaRecorder path), and only in a secure context (HTTPS).
 */

/**
 * @param {typeof globalThis} [g]
 * @returns {typeof SpeechRecognition | null}
 */
export function getSpeechRecognitionCtor(g = globalThis) {
  if (!g) return null;
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

/**
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isSpeechRecognitionSupported(g = globalThis) {
  return !!getSpeechRecognitionCtor(g);
}

/**
 * Whether getUserMedia is present (may still require secure context at call time).
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function hasGetUserMedia(g = globalThis) {
  if (!g) return false;
  const nav = g.navigator;
  if (nav?.mediaDevices?.getUserMedia) return true;
  // Legacy prefixes (rare); still useful for feature messaging
  if (typeof nav?.getUserMedia === "function") return true;
  if (typeof nav?.webkitGetUserMedia === "function") return true;
  return false;
}

/**
 * MediaRecorder dictation (record → upload to Mac). Works in iOS PWAs where
 * webkitSpeechRecognition is missing / blocked.
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isMediaRecorderDictationSupported(g = globalThis) {
  if (!g) return false;
  if (!hasGetUserMedia(g)) return false;
  if (typeof g.MediaRecorder === "undefined") return false;
  return true;
}

/**
 * Prefer a mime type the browser can record.
 * @param {typeof globalThis} [g]
 * @returns {string}
 */
export function pickAudioRecorderMime(g = globalThis) {
  const MR = g?.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") {
    return "audio/webm";
  }
  const candidates = [
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    try {
      if (MR.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/**
 * Whether any dictation path is available (browser STT or MediaRecorder).
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isAnyDictationSupported(g = globalThis) {
  return (
    isSpeechRecognitionSupported(g) ||
    isMediaRecorderDictationSupported(g) ||
    isNativeAudioFileDictationSupported(g)
  );
}

/**
 * Mic + MediaRecorder require a secure context on iOS Safari
 * (https:// or http://localhost — not plain http://LAN-IP).
 * On plain HTTP, iOS hides mediaDevices entirely — looks like "unsupported".
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isSecureDictationContext(g = globalThis) {
  if (!g) return false;
  if (typeof g.isSecureContext === "boolean") return g.isSecureContext;
  try {
    const loc = g.location;
    if (!loc) return false;
    if (loc.protocol === "https:") return true;
    const host = String(loc.hostname || "");
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Home-screen / standalone PWA (iOS blocks Web Speech here).
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isStandaloneDisplayMode(g = globalThis) {
  if (!g) return false;
  try {
    if (g.matchMedia?.("(display-mode: standalone)")?.matches) return true;
    if (g.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
    // iOS Safari legacy
    if (g.navigator?.standalone === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * iOS / iPadOS — no reliable Web Speech in PWA; always prefer MediaRecorder.
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isAppleMobileSpeech(g = globalThis) {
  if (!g) return false;
  const nav = g.navigator;
  if (!nav) return false;
  const ua = String(nav.userAgent || "");
  const platform = String(nav.platform || "");
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1);
  return iOS;
}

/**
 * Prefer record→Mac path (never rely on Web Speech for these cases).
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function preferServerDictation(g = globalThis) {
  if (!isMediaRecorderDictationSupported(g) && !hasGetUserMedia(g)) {
    // Still "prefer" server when secure context is missing on Apple — message
    // path will explain HTTPS; Web Speech won't help there either.
    return isAppleMobileSpeech(g) || isStandaloneDisplayMode(g);
  }
  return (
    isAppleMobileSpeech(g) ||
    isStandaloneDisplayMode(g) ||
    !isSpeechRecognitionSupported(g)
  );
}

/**
 * Why dictation can't start (for UI). Empty string if OK to try.
 * @param {typeof globalThis} [g]
 * @returns {string}
 */
export function dictationBlockedReason(g = globalThis) {
  // Insecure HTTP is OK — we fall back to the system voice-memo / audio file picker.
  if (
    isAnyDictationSupported(g) ||
    hasGetUserMedia(g) ||
    isNativeAudioFileDictationSupported(g)
  ) {
    return "";
  }
  return "Voice dictation isn’t available in this browser.";
}

/**
 * System audio file / voice-memo picker — works over plain http:// (no HTTPS).
 * iOS Home Screen PWAs block getUserMedia without a secure context; this path does not.
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function isNativeAudioFileDictationSupported(g = globalThis) {
  // <input type="file" accept="audio/*"> works without secure context
  return typeof g?.document?.createElement === "function";
}

/**
 * Path selection for the mic button (shipped entry for unit tests).
 * @param {typeof globalThis} [g]
 * @returns {"server-media"|"browser-speech"|"native-audio-file"|"unavailable"}
 */
export function selectDictationPath(g = globalThis) {
  const secure = isSecureDictationContext(g);
  const canLive =
    secure &&
    (isMediaRecorderDictationSupported(g) || hasGetUserMedia(g));

  if (
    canLive &&
    (preferServerDictation(g) || !isSpeechRecognitionSupported(g))
  ) {
    return "server-media";
  }
  if (
    secure &&
    isSpeechRecognitionSupported(g) &&
    !preferServerDictation(g)
  ) {
    return "browser-speech";
  }
  if (canLive) return "server-media";
  // Plain http:// LAN — free path, no paid TLS
  if (isNativeAudioFileDictationSupported(g)) return "native-audio-file";
  return "unavailable";
}

/**
 * Build editable composer draft from existing text + new transcript.
 * Never auto-sends; pure merge for review-before-send.
 * @param {string} existing
 * @param {string} transcript
 * @returns {string}
 */
export function buildComposerDraft(existing, transcript) {
  const t = String(transcript || "").trim();
  if (!t) return String(existing || "");
  const cur = String(existing || "").replace(/\s+$/u, "");
  return cur ? `${cur} ${t}` : t;
}

/**
 * Whether continuous recognition is safe. iOS Safari often ignores or
 * breaks with continuous:true — use false and restart on `end`.
 * @param {typeof globalThis} [g]
 * @returns {boolean}
 */
export function preferContinuousRecognition(g = globalThis) {
  return !isAppleMobileSpeech(g);
}

/**
 * Merge base composer text + finalized phrases + current interim hypothesis.
 * @param {string} base  Text that was already in the field when listening started
 * @param {string[]} finals  Finalized speech segments (in order)
 * @param {string} [interim]  Current partial recognition
 * @returns {string}
 */
export function mergeDictationText(base, finals, interim = "") {
  let s = String(base || "").replace(/\s+$/u, "");
  const finalJoined = (Array.isArray(finals) ? finals : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .join(" ");
  if (finalJoined) {
    s = s ? `${s} ${finalJoined}` : finalJoined;
  }
  const mid = String(interim || "").trim();
  if (mid) {
    s = s ? `${s} ${mid}` : mid;
  }
  return s;
}

/**
 * Extract final + interim strings from a SpeechRecognitionEvent-like object.
 * @param {{ results?: ArrayLike<{ isFinal?: boolean, 0?: { transcript?: string }, length?: number }> }} event
 * @param {number} [fromIndex=0]
 * @returns {{ finals: string[], interim: string, nextIndex: number }}
 */
export function consumeRecognitionResults(event, fromIndex = 0) {
  const results = event?.results;
  const finals = [];
  let interim = "";
  let i = Math.max(0, fromIndex | 0);
  const len = results?.length || 0;
  for (; i < len; i++) {
    const row = results[i];
    const piece = String(row?.[0]?.transcript || "").trim();
    if (!piece) continue;
    if (row.isFinal) finals.push(piece);
    else interim = piece;
  }
  return { finals, interim, nextIndex: len };
}

/**
 * Human-readable error for SpeechRecognition error codes.
 * @param {string} code
 * @returns {string}
 */
export function speechRecognitionErrorMessage(code) {
  const c = String(code || "");
  switch (c) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission denied. On iPhone: Settings → Safari → Microphone (or Settings → [this app] if installed to Home Screen).";
    case "no-speech":
      return "No speech heard. Tap the mic and try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition needs network on this device (Siri/dictation services).";
    case "aborted":
      return "";
    case "insecure-context":
      // Should rarely block now — native voice-memo path works on http://
      return "Live mic needs a secure page. Use voice memo instead, or free local HTTPS from the Mac bridge.";
    default:
      return c ? `Speech recognition error: ${c}` : "Speech recognition failed.";
  }
}
