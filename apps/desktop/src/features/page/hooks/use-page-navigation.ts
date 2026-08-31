import { useEffect, useRef } from "react";
import type { PageTitleOutcome } from "./page-navigation-actions";
import {
  openPage,
  retargetPage,
} from "./page-navigation-actions";
import {
  pageTitleOutcomeSourceKey,
  usePageTitleOutcomeStore,
} from "./page-title-outcome-store";

export function useOpenPage() {
  return openPage;
}

export function useRetargetPage() {
  return retargetPage;
}

export function usePageTitleOutcome(scopePath: string, path: string | null) {
  return usePageTitleOutcomeStore((state) =>
    path
      ? (state.titleOutcomeBySourceKey[
          pageTitleOutcomeSourceKey(scopePath, path)
        ] ?? null)
      : null,
  );
}

export function usePageTitleOutcomeEffect({
  scopePath,
  path,
  onOutcome,
}: {
  scopePath: string;
  path: string | null;
  onOutcome: (outcome: PageTitleOutcome) => void;
}) {
  const identityKey = path ? pageTitleOutcomeSourceKey(scopePath, path) : null;
  const outcome = usePageTitleOutcome(scopePath, path);
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
