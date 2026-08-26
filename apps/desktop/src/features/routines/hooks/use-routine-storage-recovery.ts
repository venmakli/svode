import { useCallback, useEffect, useRef, useState } from "react";

import {
  acknowledgeRoutineStorageRecovery,
  type RoutineOwnerInput,
} from "../api/routines-api";
import { routineErrorMessage } from "./use-routine-catalog";

export function useRoutineStorageRecovery({
  owner,
  retryAutomaticConsent,
}: {
  owner: RoutineOwnerInput;
  retryAutomaticConsent(): void;
}) {
  const ownerKey = JSON.stringify(owner);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestIdRef.current += 1;
    pendingRef.current = false;
    setPending(false);
    setError(null);
  }, [ownerKey]);

  const acknowledge = useCallback(async () => {
    if (pendingRef.current) return;
    const requestId = ++requestIdRef.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await acknowledgeRoutineStorageRecovery(owner);
      if (requestId !== requestIdRef.current) return;
      retryAutomaticConsent();
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(routineErrorMessage(cause));
    } finally {
      if (requestId === requestIdRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [owner, retryAutomaticConsent]);

  return { dismiss: acknowledge, error, pending };
}
