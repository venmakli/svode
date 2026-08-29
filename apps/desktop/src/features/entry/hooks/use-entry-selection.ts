import { useEffect, useRef } from "react";
import { useActiveContentSelection } from "@/features/artifact";
import type {
  EntrySelectionSnapshot,
  EntryTitleOutcome,
} from "./entry-selection-actions";
import {
  closeEntryDocument,
  entrySelectionSnapshotFromContent,
  openEntryDocument,
  openEntryScopeHome,
  retargetEntryDocument,
} from "./entry-selection-actions";
import {
  entryTitleOutcomeSourceKey,
  useEntryTitleOutcomeStore,
} from "./entry-title-outcome-store";

export function useActiveEntrySelection(): EntrySelectionSnapshot {
  return entrySelectionSnapshotFromContent(useActiveContentSelection());
}

export function useActiveEntryDocument() {
  return useActiveEntrySelection().activeDocument;
}

export function useActiveEntryDocumentSpaceId() {
  return useActiveEntrySelection().activeDocumentSpaceId;
}

export function useOpenEntryDocument() {
  return openEntryDocument;
}

export function useOpenEntryScopeHome() {
  return openEntryScopeHome;
}

export function useRetargetEntryDocument() {
  return retargetEntryDocument;
}

export function useEntryTitleOutcome(scopePath: string, path: string | null) {
  return useEntryTitleOutcomeStore((state) =>
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
  return closeEntryDocument;
}
