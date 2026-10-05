#!/usr/bin/env node
// Download the small speech model the svode-speech process tests recognize
// their fixture with, verify its SHA-256 and print its path.
//
// The model is too large for Git, so it lives in the workspace target
// directory, which the tests read by default (or SVODE_SPEECH_TEST_MODEL).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = {
  url: "https://huggingface.co/handy-computer/whisper-tiny-gguf/resolve/2678cc66038359b97c8e6fd6454c56fc9006d571/whisper-tiny-Q8_0.gguf",
  sha256: "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
  file: "whisper-tiny-Q8_0.gguf",
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = process.env.SVODE_SPEECH_TEST_MODEL
  ? resolve(process.env.SVODE_SPEECH_TEST_MODEL)
  : resolve(root, "target/speech-test", MODEL.file);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (existsSync(dest) && sha256(readFileSync(dest)) === MODEL.sha256) {
  console.log(dest);
  process.exit(0);
}

const response = await fetch(MODEL.url);
if (!response.ok) {
  throw new Error(`model download failed: HTTP ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const actual = sha256(bytes);
if (actual !== MODEL.sha256) {
  throw new Error(`model SHA-256 mismatch: expected ${MODEL.sha256}, got ${actual}`);
}

mkdirSync(dirname(dest), { recursive: true });
const partial = `${dest}.partial`;
rmSync(partial, { force: true });
writeFileSync(partial, bytes);
renameSync(partial, dest);
console.log(dest);
