import { useEffect, useRef } from "react";
import { useShallow } from "zustand/shallow";
import type {
  EntrySelectionSnapshot,
  EntryTitleOutcome,
} from "./entry-selection-actions";
import {
  entryTitleOutcomeSourceKey,
  useEntrySelectionStore,
} from "./entry-selection-store";

export function useActiveEntrySelection(): EntrySelectionSnapshot {
  return useEntrySelectionStore(
    useShallow(
      (state): EntrySelectionSnapshot => ({
        activeDocument: state.activeDocument,
        activeDocumentSpaceId: state.activeDocumentSpaceId,
        activeRevealRequest: state.activeRevealRequest,
        activeScopeOpenRequest: state.activeScopeOpenRequest,
        activePathRetarget: state.activePathRetarget,
      }),
    ),
  );
}

export function useActiveEntryDocument() {
  return useEntrySelectionStore((state) => state.activeDocument);
}

export function useActiveEntryDocumentSpaceId() {
  return useEntrySelectionStore((state) => state.activeDocumentSpaceId);
}

export function useOpenEntryDocument() {
  return useEntrySelectionStore((state) => state.openDocument);
}

export function useOpenEntryScopeHome() {
  return useEntrySelectionStore((state) => state.openScopeHome);
}

export function useRetargetEntryDocument() {
  return useEntrySelectionStore((state) => state.retargetDocument);
}

export function useEntryTitleOutcome(scopePath: string, path: string | null) {
  return useEntrySelectionStore((state) =>
    path
      ? (state.titleOutcomeBySourceKey[
          entryTitleOutcomeSourceKey(scopePath, path)
        ] ?? null)
      : null,
  );
}

export function useEntryTitleOutcomeEffect({
  scopePath,
  path,
  onOutcome,
}: {
  scopePath: string;
  path: string | null;
  onOutcome: (outcome: EntryTitleOutcome) => void;
}) {
  const identityKey = path ? entryTitleOutcomeSourceKey(scopePath, path) : null;
  const outcome = useEntryTitleOutcome(scopePath, path);
  const observedIdentityKeyRef = useRef(identityKey);
  const appliedOutcomeKeyRef = useRef<number | null>(outcome?.key ?? null);
  const onOutcomeRef = useRef(onOutcome);

  useEffect(() => {
    onOutcomeRef.current = onOutcome;
  }, [onOutcome]);

  useEffect(() => {
    if (observedIdentityKeyRef.current !== identityKey) {
      observedIdentityKeyRef.current = identityKey;
      appliedOutcomeKeyRef.current = outcome?.key ?? null;
      return;
    }
    if (!outcome || appliedOutcomeKeyRef.current === outcome.key) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      appliedOutcomeKeyRef.current = outcome.key;
      onOutcomeRef.current(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey, outcome]);
}

export function useCloseEntryDocument() {
  return useEntrySelectionStore((state) => state.closeDocument);
}
