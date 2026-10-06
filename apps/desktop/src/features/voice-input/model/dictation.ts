import type {
  DictationFailureDto,
  DictationOwnerDto,
} from "@/platform/speech/speech-api";

/** The recording stops as ■ at two minutes (`06`). */
export const RECORDING_LIMIT_MS = 120_000;
/** The last ten seconds count down. */
export const COUNTDOWN_MS = 10_000;

/** A failure the recording row shows; others need no row. */
export type DictationRowFailure = Exclude<
  DictationFailureDto,
  { code: "busy" } | { code: "cancelled" }
>;

/**
 * The recording row of one composer (`04` view, `06` states). `send`
 * remembers ↑: the text is sent once it is in the draft.
 */
export type DictationPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "recording"; startedAt: number }
  | { phase: "recognizing"; send: boolean }
  | { phase: "failed"; failure: DictationRowFailure; send: boolean };

export type DictationEvent =
  | { type: "start" }
  | { type: "started"; at: number }
  | { type: "finish"; send: boolean }
  /** "Повторить" recognizes the same audio. */
  | { type: "retry" }
  | { type: "text" }
  | { type: "failed"; failure: DictationFailureDto }
  | { type: "cancel" };

export const IDLE: DictationPhase = { phase: "idle" };

export function dictationReducer(
  state: DictationPhase,
  event: DictationEvent,
): DictationPhase {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "failed"
        ? { phase: "starting" }
        : state;
    case "started":
      return state.phase === "starting"
        ? { phase: "recording", startedAt: event.at }
        : state;
    case "finish":
      return state.phase === "recording"
        ? { phase: "recognizing", send: event.send }
        : state;
    case "retry":
      return state.phase === "failed" && state.failure.code === "recognition"
        ? { phase: "recognizing", send: state.send }
        : state;
    case "text":
      return IDLE;
    case "failed": {
      const failure = event.failure;
      if (failure.code === "busy" || failure.code === "cancelled") return IDLE;
      // Without a model the enable popover takes over.
      if (failure.code === "modelMissing" && state.phase === "starting") return IDLE;
      return {
        phase: "failed",
        failure,
        send: state.phase === "recognizing" ? state.send : false,
      };
    }
    case "cancel":
      return IDLE;
  }
}

/** Whether the recording row takes the place of the composer's bottom row. */
export function showsRecordingRow(state: DictationPhase): boolean {
  return state.phase !== "idle" && state.phase !== "starting";
}

/** The elapsed time, or the countdown in the last ten seconds. */
export function recordingClock(elapsedMs: number): {
  text: string;
  countdown: boolean;
} {
  const left = RECORDING_LIMIT_MS - elapsedMs;
  const countdown = left <= COUNTDOWN_MS;
  const seconds = countdown
    ? Math.max(0, Math.ceil(left / 1000))
    : Math.floor(elapsedMs / 1000);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { text, countdown };
}

/** The height of a bar of the level wave, 0–1, from −60 dBFS up. */
export function levelHeight(dbfs: number): number {
  return Math.min(1, Math.max(0, (dbfs + 60) / 50));
}

/**
 * The recognized text as it goes in after `before`, the text left of the
 * cursor: trimmed, and set apart from a word it would otherwise join.
 */
export function dictatedText(text: string, before: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return before && !/\s$/.test(before) ? ` ${trimmed}` : trimmed;
}

/** Whether `owner` is a composer other than `key` of this webview. */
export function recordsElsewhere(
  owner: DictationOwnerDto | null,
  webview: string,
  key: string,
): boolean {
  return owner !== null && !(owner.webview === webview && owner.key === key);
}
