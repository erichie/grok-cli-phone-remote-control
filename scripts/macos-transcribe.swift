#!/usr/bin/env swift
/**
 * On-device speech-to-text for phone dictation (macOS Speech framework).
 * Usage: swift scripts/macos-transcribe.swift /path/to/audio.wav [locale]
 * Prints transcript to stdout. Exit 0 on success.
 */
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("usage: macos-transcribe.swift <audio-file> [locale]\n", stderr)
  exit(2)
}

let path = args[1]
let localeId = args.count >= 3 ? args[2] : Locale.current.identifier
let url = URL(fileURLWithPath: path)

guard FileManager.default.fileExists(atPath: path) else {
  fputs("file not found: \(path)\n", stderr)
  exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var outText = ""
var outError = ""

func finish() {
  semaphore.signal()
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else {
    outError = "speech authorization denied (System Settings → Privacy → Speech Recognition)"
    finish()
    return
  }

  let locale = Locale(identifier: localeId)
  guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
    outError = "SFSpeechRecognizer unavailable"
    finish()
    return
  }
  guard recognizer.isAvailable else {
    outError = "speech recognizer not available"
    finish()
    return
  }

  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  if #available(macOS 13.0, *) {
    request.addsPunctuation = true
  }

  recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
      // Often fires once with a cancellation after final — ignore if we have text
      if outText.isEmpty {
        outError = error.localizedDescription
      }
      finish()
      return
    }
    if let result = result {
      outText = result.bestTranscription.formattedString
      if result.isFinal {
        finish()
      }
    }
  }
}

let waitResult = semaphore.wait(timeout: .now() + 90)
if waitResult == .timedOut {
  fputs("transcription timed out\n", stderr)
  exit(1)
}

let text = outText.trimmingCharacters(in: .whitespacesAndNewlines)
if !text.isEmpty {
  print(text)
  exit(0)
}

fputs((outError.isEmpty ? "empty transcript" : outError) + "\n", stderr)
exit(1)
