import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadRoutineAutomaticConsent,
  updateRoutineAutomaticConsent,
} from "../api/routines-api";
import { routineErrorMessage } from "./use-routine-catalog";

export function useRoutineAutomaticConsent(projectPath: string) {
  const requestIdRef = useRef(0);
  const [state, setState] = useState<{
    enabled: boolean;
    error: string | null;
    loading: boolean;
    pending: boolean;
  }>({ enabled: false, error: null, loading: true, pending: false });

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    setState({ enabled: false, error: null, loading: true, pending: false });
    void loadRoutineAutomaticConsent(projectPath).then(
      (consent) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({
          enabled: consent.enabled,
          error: null,
          loading: false,
          pending: false,
        });
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({
          enabled: false,
          error: routineErrorMessage(error),
          loading: false,
          pending: false,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const requestId = ++requestIdRef.current;
      setState((current) => ({
        ...current,
        error: null,
        pending: true,
      }));
      try {
        const consent = await updateRoutineAutomaticConsent(
          projectPath,
          enabled,
        );
        if (requestId !== requestIdRef.current) return;
        setState({
          enabled: consent.enabled,
          error: null,
          loading: false,
          pending: false,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setState((current) => ({
          ...current,
          error: routineErrorMessage(error),
          pending: false,
        }));
      }
    },
    [projectPath],
  );

  return { ...state, setEnabled };
}
