import { useCallback, useRef, useState } from "react";

import type { RepositoryAccessSnapshot } from "@/features/git";
import type { ActorMutationIntent } from "../model/identity-mutation";

interface ActorAccessPreflightOptions<Intent extends { kind: string }> {
  error: string | null;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
  onContinue(intent: Intent): void;
  onVerify(): Promise<RepositoryAccessSnapshot | null>;
}

export function useActorAccessPreflight<
  Intent extends { kind: string } = ActorMutationIntent,
>({
  error,
  snapshot,
  verifying,
  onContinue,
  onVerify,
}: ActorAccessPreflightOptions<Intent>) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const attemptIdRef = useRef(0);
  const verificationRef = useRef<{
    attemptId: number;
    promise: Promise<void>;
    token: symbol;
  } | null>(null);

  const verifyAndContinue = useCallback(
    (pendingIntent: Intent, attemptId: number) => {
      if (verificationRef.current?.attemptId === attemptId) {
        return verificationRef.current.promise;
      }

      const token = Symbol();
      const promise = (async (): Promise<void> => {
        try {
          const verifiedSnapshot = await onVerify();
          if (
            attemptId !== attemptIdRef.current ||
            !allowsMutation(verifiedSnapshot)
          ) {
            return;
          }
          setIntent(null);
          onContinue(pendingIntent);
        } finally {
          if (verificationRef.current?.token === token) {
            verificationRef.current = null;
          }
        }
      })();
      verificationRef.current = { attemptId, promise, token };
      return promise;
    },
    [onContinue, onVerify],
  );

  const request = useCallback(
    (nextIntent: Intent) => {
      if (!error && !verifying && allowsMutation(snapshot)) {
        onContinue(nextIntent);
        return;
      }

      const attemptId = ++attemptIdRef.current;
      setIntent(nextIntent);
      if (verifying || snapshot?.status === "checking") {
        void verifyAndContinue(nextIntent, attemptId);
      }
    },
    [error, onContinue, snapshot, verifying, verifyAndContinue],
  );

  const close = useCallback(() => {
    ++attemptIdRef.current;
    setIntent(null);
  }, []);
  const verify = useCallback(() => {
    if (!intent || verifying || snapshot?.status === "checking") return;
    const attemptId = attemptIdRef.current;
    void verifyAndContinue(intent, attemptId);
  }, [intent, snapshot?.status, verifying, verifyAndContinue]);

  return { close, intent, request, verify };
}

function allowsMutation(snapshot: RepositoryAccessSnapshot | null) {
  return snapshot?.status === "local" || snapshot?.status === "writable";
}
