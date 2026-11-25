import { useCallback, useSyncExternalStore } from "react";
import {
  readComposerDraft,
  subscribeComposerDraft,
  updateComposerDraft,
  type ComposerDraft,
} from "../model/composer";

const EMPTY: ComposerDraft = { parts: [] };

/** The window's draft, shared by mounted fields and in-flight sends. */
export function useComposerDraft(key: string) {
  const subscribe = useCallback((listener: () => void) =>
    subscribeComposerDraft(key, listener), [key]);
  const getDraft = useCallback(() => readComposerDraft(key) ?? EMPTY, [key]);
  const draft = useSyncExternalStore(subscribe, getDraft);
  const update = useCallback(
    (change: Parameters<typeof updateComposerDraft>[1]) => updateComposerDraft(key, change),
    [key],
  );
  return [draft, update] as const;
}
