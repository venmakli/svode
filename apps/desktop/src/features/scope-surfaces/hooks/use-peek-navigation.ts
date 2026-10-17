import { registerSupplementalContentDeactivation } from "@/features/artifact";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { PeekLeaveAction, PeekNavigationGuard } from "../model/peek";

export function usePeekNavigation<T>(
  requested: T | null,
  identity: (target: T) => string,
) {
  const [target, setTarget] = useState(requested);
  const [sessionKey, setSessionKey] = useState(0);
  const guardRef = useRef<PeekNavigationGuard | null>(null);
  const pendingRef = useRef(false);
  const adoptedIdentity = useRef<string | null>(null);
  const registerNavigationGuard = useCallback((guard: PeekNavigationGuard) => {
    guardRef.current = guard;
    const unregister = registerSupplementalContentDeactivation(async () =>
      (await guard()) ? "ready" : "blocked",
    );
    return () => {
      unregister();
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);
  const preparationRef = useRef<Promise<boolean> | null>(null);
  const prepare = useCallback((action?: PeekLeaveAction) => {
    if (preparationRef.current) return preparationRef.current;
    const request = Promise.resolve()
      .then(async () => !guardRef.current || (await guardRef.current(action)))
      .catch((error) => {
        console.error(error);
        toast.error(m.toast_error());
        return false;
      })
      .finally(() => {
        if (preparationRef.current === request) preparationRef.current = null;
      });
    preparationRef.current = request;
    return request;
  }, []);
  const leave = useCallback(
    async (
      action: () => void | Promise<void>,
      leaveAction?: PeekLeaveAction,
    ) => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      try {
        if (!(await prepare(leaveAction))) return false;
        await action();
        return true;
      } catch (error) {
        console.error(error);
        toast.error(m.toast_error());
        return false;
      } finally {
        pendingRef.current = false;
      }
    },
    [prepare],
  );
  const requestedIdentity = requested ? identity(requested) : null;
  const currentIdentity = target ? identity(target) : null;
  useEffect(() => {
    let cancelled = false;
    if (target === requested) return;
    const same =
      requestedIdentity === currentIdentity ||
      (requestedIdentity !== null &&
        requestedIdentity === adoptedIdentity.current);
    queueMicrotask(() => {
      if (cancelled) return;
      const apply = () => {
        if (cancelled) return;
        setTarget(requested);
        if (!same) setSessionKey((key) => key + 1);
      };
      if (same) apply();
      else
        void prepare().then((ready) => {
          if (ready) apply();
        });
    });
    return () => {
      cancelled = true;
    };
  }, [currentIdentity, prepare, requested, requestedIdentity, target]);
  return {
    target,
    sessionKey: String(sessionKey),
    leave,
    registerNavigationGuard,
    dismiss: () => setTarget(null),
    adoptIdentity: (value: string) => {
      adoptedIdentity.current = value;
    },
  };
}
