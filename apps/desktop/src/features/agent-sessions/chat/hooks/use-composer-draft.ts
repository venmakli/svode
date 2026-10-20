import { useCallback, useEffect, useRef, useState } from "react";
import {
  readComposerDraft,
  subscribeComposerDraft,
  writeComposerDraft,
  type ComposerDraft,
} from "../model/composer";

const EMPTY: ComposerDraft = { parts: [] };

/** A composer draft kept in the window's session storage under `key`. */
export function useComposerDraft(key: string) {
  const [state, setState] = useState(() => ({
    key,
    draft: readComposerDraft(key) ?? EMPTY,
  }));
  // The draft every change builds on. It moves with each change at once,
  // so a change is stored even when React drops the render it queued
  // because the surface goes in the same batch (DF-214).
  const latest = useRef(state);
  const current =
    state.key === key ? state.draft : (readComposerDraft(key) ?? EMPTY);
  if (state.key !== key) setState({ key, draft: current });

  // Dictation appends to a draft whose composer is not shown.
  useEffect(
    () =>
      subscribeComposerDraft(key, () => {
        latest.current = { key, draft: readComposerDraft(key) ?? EMPTY };
        setState(latest.current);
      }),
    [key],
  );

  const update = useCallback(
    (change: Partial<ComposerDraft> | ((draft: ComposerDraft) => ComposerDraft)) => {
      const base =
        latest.current.key === key
          ? latest.current.draft
          : (readComposerDraft(key) ?? EMPTY);
      const next =
        typeof change === "function" ? change(base) : { ...base, ...change };
      writeComposerDraft(key, next);
      latest.current = { key, draft: next };
      setState(latest.current);
    },
    [key],
  );
  return [current, update] as const;
}
