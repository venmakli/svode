import { expect, test } from "bun:test";
import {
  dictatedText,
  dictationReducer,
  IDLE,
  levelHeight,
  recordingClock,
  recordsElsewhere,
  showsRecordingRow,
  type DictationPhase,
} from "./dictation";

const recording: DictationPhase = { phase: "recording", startedAt: 0 };

test("a dictation records, recognizes and ends with the text", () => {
  const starting = dictationReducer(IDLE, { type: "start" });
  expect(starting).toEqual({ phase: "starting" });
  expect(showsRecordingRow(starting)).toBe(false);
  const started = dictationReducer(starting, { type: "started", at: 5 });
  expect(started).toEqual({ phase: "recording", startedAt: 5 });
  expect(showsRecordingRow(started)).toBe(true);
  const recognizing = dictationReducer(started, { type: "finish", send: false });
  expect(recognizing).toEqual({ phase: "recognizing", send: false });
  expect(dictationReducer(recognizing, { type: "text" })).toEqual(IDLE);
});

test("↑ is remembered through a failed recognition and its retry", () => {
  const sending = dictationReducer(recording, { type: "finish", send: true });
  const failed = dictationReducer(sending, {
    type: "failed",
    failure: { code: "recognition" },
  });
  expect(failed).toEqual({ phase: "failed", failure: { code: "recognition" }, send: true });
  expect(dictationReducer(failed, { type: "retry" })).toEqual({
    phase: "recognizing",
    send: true,
  });
});

test("only a failed recognition can be retried", () => {
  const silent = dictationReducer(
    { phase: "recognizing", send: false },
    { type: "failed", failure: { code: "noSignal", soundSettings: true } },
  );
  expect(silent.phase).toBe("failed");
  expect(dictationReducer(silent, { type: "retry" })).toBe(silent);
});

test("capture failures of each OS show in the row", () => {
  for (const failure of [
    { code: "denied", recovery: { kind: "resetCommand", command: "tccutil reset Microphone app.svode.desktop" } },
    { code: "denied", recovery: { kind: "openSettings" } },
    { code: "denied", recovery: { kind: "none" } },
    { code: "noDevice" },
    { code: "device" },
  ] as const) {
    const state = dictationReducer({ phase: "starting" }, { type: "failed", failure });
    expect(state).toEqual({ phase: "failed", failure, send: false });
  }
});

test("a missing model at start opens the popover instead of the row; busy and cancelled end quietly", () => {
  expect(
    dictationReducer({ phase: "starting" }, { type: "failed", failure: { code: "modelMissing" } }),
  ).toEqual(IDLE);
  // Removed between the recording and its recognition: the row leads
  // to the popover.
  expect(
    dictationReducer(
      { phase: "recognizing", send: false },
      { type: "failed", failure: { code: "modelMissing" } },
    ).phase,
  ).toBe("failed");
  expect(dictationReducer(recording, { type: "failed", failure: { code: "busy" } })).toEqual(IDLE);
  expect(
    dictationReducer({ phase: "recognizing", send: true }, { type: "failed", failure: { code: "cancelled" } }),
  ).toEqual(IDLE);
});

test("✕ and Esc cancel in every phase", () => {
  for (const state of [
    { phase: "starting" },
    recording,
    { phase: "recognizing", send: false },
    { phase: "failed", failure: { code: "recognition" }, send: false },
  ] as DictationPhase[]) {
    expect(dictationReducer(state, { type: "cancel" })).toEqual(IDLE);
  }
});

test("events out of order leave the state alone", () => {
  expect(dictationReducer(IDLE, { type: "finish", send: false })).toEqual(IDLE);
  expect(dictationReducer(IDLE, { type: "started", at: 1 })).toEqual(IDLE);
  expect(dictationReducer(recording, { type: "start" })).toBe(recording);
});

test("the clock counts up, then down in the last ten seconds", () => {
  expect(recordingClock(0)).toEqual({ text: "0:00", countdown: false });
  expect(recordingClock(65_400)).toEqual({ text: "1:05", countdown: false });
  expect(recordingClock(109_999)).toEqual({ text: "1:49", countdown: false });
  expect(recordingClock(110_000)).toEqual({ text: "0:10", countdown: true });
  expect(recordingClock(119_100)).toEqual({ text: "0:01", countdown: true });
  expect(recordingClock(121_000)).toEqual({ text: "0:00", countdown: true });
});

test("the dictated text joins the draft at the cursor", () => {
  expect(dictatedText(" Привет мир", "")).toBe("Привет мир");
  expect(dictatedText("fix the import", "Please")).toBe(" fix the import");
  expect(dictatedText("fix the import", "Please ")).toBe("fix the import");
  expect(dictatedText("next", "line\n")).toBe("next");
  expect(dictatedText("   ", "text")).toBe("");
});

test("the microphone waits while another composer of any window records", () => {
  expect(recordsElsewhere(null, "main", "session:a")).toBe(false);
  expect(recordsElsewhere({ webview: "main", key: "session:a" }, "main", "session:a")).toBe(false);
  expect(recordsElsewhere({ webview: "main", key: "session:b" }, "main", "session:a")).toBe(true);
  expect(recordsElsewhere({ webview: "project-1", key: "session:a" }, "main", "session:a")).toBe(true);
});

test("the wave maps levels from −60 dBFS up", () => {
  expect(levelHeight(-100)).toBe(0);
  expect(levelHeight(-60)).toBe(0);
  expect(levelHeight(-35)).toBe(0.5);
  expect(levelHeight(0)).toBe(1);
});
