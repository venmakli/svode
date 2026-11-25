import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type DictationEvent,
  type DictationPhase,
} from "../model/dictation";
import { LevelHistory } from "../model/levels";
import { useDictationOwner } from "./use-dictation-owner";

export interface DictationTarget {
  /** The composer's own id; its draft keeps the text when it is gone. */
  key: string;
  /** A closing surface may still mount its field while it animates out. */
  active?: boolean;
  /** Inserts the text at the cursor; `send` is ↑. */
  onText: (text: string, send: boolean) => void;
  /** Captures the destination when the field goes, including an earlier ↑. */
  onDetach: () => (text: string, send: boolean) => void;
}

/** One recording run; it outlives its composer to deliver the text. */
interface Run {
  key: string;
  deliverDetached?: (text: string, send: boolean) => void;
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
export function useDictation({ key, active = true, onText, onDetach }: DictationTarget): Dictation {
  const [state, setState] = useState<DictationPhase>(IDLE);
  const [enableOpen, setEnableOpen] = useState(false);
  const levels = useMemo(() => new LevelHistory(), []);
  const owner = useDictationOwner();
  const busyElsewhere = recordsElsewhere(owner, currentDictationWebview(), key);

  const stateRef = useRef<DictationPhase>(IDLE);
  const dispatch = useCallback((event: DictationEvent) => {
    // Navigation can clean up the field in the same batch as ↑.
    stateRef.current = dictationReducer(stateRef.current, event);
    setState(stateRef.current);
  }, []);
  const runRef = useRef<Run | null>(null);
  const targetRef = useRef({ onText, onDetach });
  useLayoutEffect(() => {
    targetRef.current = { onText, onDetach };
  });

  const recognize = useCallback(async (run: Run, send: boolean) => {
    const result = await finishDictation(run.key).catch(() => ({
      outcome: "failed" as const,
      failure: RECOGNITION_FAILED,
    }));
    if (run.deliverDetached) {
      if (result.outcome === "text") run.deliverDetached(result.text, send);
      // Nobody can retry: the kept audio goes.
      else if (result.failure.code === "recognition") void cancelDictation(run.key);
      return;
    }
    if (runRef.current !== run) return;
    if (result.outcome === "text") {
      runRef.current = null;
      dispatch({ type: "text" });
      targetRef.current.onText(result.text, send);
      return;
    }
    if (result.failure.code !== "recognition") runRef.current = null;
    dispatch({ type: "failed", failure: result.failure });
  }, [dispatch]);

  const start = useCallback(() => {
    const phase = stateRef.current.phase;
    if (!active || busyElsewhere || (phase !== "idle" && phase !== "failed")) return;
    const run: Run = { key };
    runRef.current = run;
    levels.clear();
    dispatch({ type: "start" });
    void startDictation(key, (dbfs) => levels.push(dbfs))
      .catch((): DictationFailureDto => ({ code: "device" }))
      .then((failure) => {
        if (run.deliverDetached) {
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
  }, [active, busyElsewhere, dispatch, key, levels]);

  const finish = useCallback(
    (send: boolean) => {
      const run = runRef.current;
      if (!run || stateRef.current.phase !== "recording") return;
      dispatch({ type: "finish", send });
      void recognize(run, send);
    },
    [dispatch, recognize],
  );

  const retry = useCallback(() => {
    const run = runRef.current;
    const current = stateRef.current;
    if (!run || current.phase !== "failed" || current.failure.code !== "recognition") {
      return;
    }
    dispatch({ type: "retry" });
    void recognize(run, current.send);
  }, [dispatch, recognize]);

  const cancel = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    dispatch({ type: "cancel" });
    levels.clear();
    if (run) void cancelDictation(run.key);
  }, [dispatch, levels]);

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
  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      const run = runRef.current;
      runRef.current = null;
      if (!run) return;
      const phase = stateRef.current.phase;
      run.deliverDetached = targetRef.current.onDetach();
      if (phase === "recording") void recognize(run, false);
      else if (phase === "failed") void cancelDictation(run.key);
      dispatch({ type: "cancel" });
    };
  }, [active, dispatch, key, recognize]);

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
