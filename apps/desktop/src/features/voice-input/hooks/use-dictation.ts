import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  cancelDictation,
  currentDictationWebview,
  finishDictation,
  startDictation,
  type DictationFailureDto,
} from "../api";
import {
  dictationReducer,
  IDLE,
  RECORDING_LIMIT_MS,
  recordsElsewhere,
  type DictationPhase,
} from "../model/dictation";
import { LevelHistory } from "../model/levels";
import { useDictationOwner } from "./use-dictation-owner";

export interface DictationTarget {
  /** The composer's own id; its draft keeps the text when it is gone. */
  key: string;
  /** Inserts the text at the cursor; `send` is ↑. */
  onText: (text: string, send: boolean) => void;
  /**
   * The composer was closed or replaced while recording or recognizing
   * (`06`, stop from outside): the text goes into its kept draft, unsent.
   */
  onDetachedText: (key: string, text: string) => void;
}

/** One recording run; it outlives its composer to deliver the text. */
interface Run {
  key: string;
  detached: boolean;
}

const RECOGNITION_FAILED: DictationFailureDto = { code: "recognition" };

export interface Dictation {
  state: DictationPhase;
  levels: LevelHistory;
  /** Another composer records: this one's microphone waits. */
  busyElsewhere: boolean;
  /** The enable popover, also opened when the model is missing. */
  enableOpen: boolean;
  setEnableOpen: (open: boolean) => void;
  start: () => void;
  /** ■, or ↑ with `send`. */
  finish: (send: boolean) => void;
  retry: () => void;
  /** ✕ and Esc: the audio is dropped and the draft stays as it was. */
  cancel: () => void;
  /** The hotkey: starts, or stops as ■. */
  toggle: () => void;
}

/**
 * Dictation into one composer (`06`): the recording and its recognition,
 * ↑, retry and cancel, the two-minute limit, and the stop from outside —
 * the composer closing or giving way (another session, a closed peek, the
 * agent's request card) stops the recording as ■ and its text lands in
 * the kept draft.
 */
export function useDictation({ key, onText, onDetachedText }: DictationTarget): Dictation {
  const [state, dispatch] = useReducer(dictationReducer, IDLE);
  const [enableOpen, setEnableOpen] = useState(false);
  const levels = useMemo(() => new LevelHistory(), []);
  const owner = useDictationOwner();
  const busyElsewhere = recordsElsewhere(owner, currentDictationWebview(), key);

  const stateRef = useRef(state);
  const runRef = useRef<Run | null>(null);
  const targetRef = useRef({ onText, onDetachedText });
  useEffect(() => {
    stateRef.current = state;
    targetRef.current = { onText, onDetachedText };
  });

  const recognize = useCallback(async (run: Run, send: boolean) => {
    const result = await finishDictation(run.key).catch(() => ({
      outcome: "failed" as const,
      failure: RECOGNITION_FAILED,
    }));
    if (result.outcome === "text") {
      if (run.detached) {
        targetRef.current.onDetachedText(run.key, result.text);
        return;
      }
      runRef.current = null;
      dispatch({ type: "text" });
      targetRef.current.onText(result.text, send);
      return;
    }
    if (run.detached) {
      // Nobody can retry: the kept audio goes.
      if (result.failure.code === "recognition") void cancelDictation(run.key);
      return;
    }
    if (result.failure.code !== "recognition") runRef.current = null;
    dispatch({ type: "failed", failure: result.failure });
  }, []);

  const start = useCallback(() => {
    const phase = stateRef.current.phase;
    if (busyElsewhere || (phase !== "idle" && phase !== "failed")) return;
    const run: Run = { key, detached: false };
    runRef.current = run;
    levels.clear();
    dispatch({ type: "start" });
    void startDictation(key, (dbfs) => levels.push(dbfs))
      .catch((): DictationFailureDto => ({ code: "device" }))
      .then((failure) => {
        if (run.detached) {
          if (!failure) void cancelDictation(run.key);
          return;
        }
        if (runRef.current !== run) return;
        if (failure) {
          runRef.current = null;
          dispatch({ type: "failed", failure });
          if (failure.code === "modelMissing") setEnableOpen(true);
          return;
        }
        dispatch({ type: "started", at: Date.now() });
      });
  }, [busyElsewhere, key, levels]);

  const finish = useCallback(
    (send: boolean) => {
      const run = runRef.current;
      if (!run || stateRef.current.phase !== "recording") return;
      dispatch({ type: "finish", send });
      void recognize(run, send);
    },
    [recognize],
  );

  const retry = useCallback(() => {
    const run = runRef.current;
    const current = stateRef.current;
    if (!run || current.phase !== "failed" || current.failure.code !== "recognition") {
      return;
    }
    dispatch({ type: "retry" });
    void recognize(run, current.send);
  }, [recognize]);

  const cancel = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    dispatch({ type: "cancel" });
    levels.clear();
    if (run) void cancelDictation(run.key);
  }, [levels]);

  const toggle = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase === "recording") finish(false);
    else if (phase === "idle" || phase === "failed") start();
  }, [finish, start]);

  // ■ at the limit.
  const startedAt = state.phase === "recording" ? state.startedAt : null;
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setTimeout(
      () => finish(false),
      Math.max(0, RECORDING_LIMIT_MS - (Date.now() - startedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [finish, startedAt]);

  // The composer goes, or turns to another draft: a recording stops as ■
  // into the kept draft, a failed one drops its audio.
  useEffect(
    () => () => {
      const run = runRef.current;
      runRef.current = null;
      if (!run) return;
      run.detached = true;
      const phase = stateRef.current.phase;
      if (phase === "recording") void recognize(run, false);
      else if (phase === "failed") void cancelDictation(run.key);
      dispatch({ type: "cancel" });
    },
    [key, recognize],
  );

  return {
    state,
    levels,
    busyElsewhere,
    enableOpen,
    setEnableOpen,
    start,
    finish,
    retry,
    cancel,
    toggle,
  };
}
