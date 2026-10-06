import { useCallback, useEffect, useState } from "react";
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
  const current =
    state.key === key ? state.draft : (readComposerDraft(key) ?? EMPTY);
  if (state.key !== key) setState({ key, draft: current });

  // Dictation appends to a draft whose composer is not shown.
  useEffect(
    () =>
      subscribeComposerDraft(key, () =>
        setState({ key, draft: readComposerDraft(key) ?? EMPTY }),
      ),
    [key],
  );

  const update = useCallback(
    (change: Partial<ComposerDraft> | ((draft: ComposerDraft) => ComposerDraft)) => {
      setState((previous) => {
        const base = previous.key === key ? previous.draft : EMPTY;
        const next =
          typeof change === "function" ? change(base) : { ...base, ...change };
        writeComposerDraft(key, next);
        return { key, draft: next };
      });
    },
    [key],
  );
  return [current, update] as const;
}
