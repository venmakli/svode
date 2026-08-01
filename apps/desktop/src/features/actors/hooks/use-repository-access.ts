import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkRepositoryAccess,
  loadRepositoryAccess,
} from "../api/repository-access-api";
import type { RepositoryAccessSnapshot } from "../model/repository-access";

interface RepositoryAccessState {
  error: string | null;
  snapshot: RepositoryAccessSnapshot | null;
  spacePath: string;
  verifying: boolean;
}

export function useRepositoryAccess(spacePath: string) {
  const [state, setState] = useState<RepositoryAccessState>({
    error: null,
    snapshot: null,
    spacePath,
    verifying: false,
  });
  const requestIdRef = useRef(0);
  const currentState =
    state.spacePath === spacePath
      ? state
      : {
          error: null,
          snapshot: null,
          spacePath,
          verifying: false,
        };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    void loadRepositoryAccess(spacePath).then(
      (snapshot) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({
          error: null,
          snapshot,
          spacePath,
          verifying: false,
        });
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({
          error: errorMessage(error),
          snapshot: null,
          spacePath,
          verifying: false,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [spacePath]);

  const verify = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) => ({
      error: null,
      snapshot: current.spacePath === spacePath ? current.snapshot : null,
      spacePath,
      verifying: true,
    }));

    try {
      const snapshot = await checkRepositoryAccess(spacePath);
      if (requestId !== requestIdRef.current) return;
      setState({
        error: null,
        snapshot,
        spacePath,
        verifying: false,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState((current) => ({
        error: errorMessage(error),
        snapshot: current.spacePath === spacePath ? current.snapshot : null,
        spacePath,
        verifying: false,
      }));
    }
  }, [spacePath]);

  return { ...currentState, verify };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown repository access error";
}
