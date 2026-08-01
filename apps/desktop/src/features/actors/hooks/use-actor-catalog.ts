import { useCallback, useEffect, useRef, useState } from "react";

import { loadActorCatalog, refreshActorCatalog } from "../api/actors-api";
import {
  beginActorCatalogRefresh,
  completeActorCatalogRefresh,
  failActorCatalogRefresh,
  type ActorCatalogState,
} from "../model/catalog-state";

export function useActorCatalog(spacePath: string) {
  const [state, setState] = useState<ActorCatalogState>({
    phase: "initial",
    spacePath,
  });
  const requestIdRef = useRef(0);
  const currentState: ActorCatalogState =
    state.spacePath === spacePath ? state : { phase: "initial", spacePath };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    void loadActorCatalog(spacePath).then(
      (snapshot) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState(completeActorCatalogRefresh(spacePath, snapshot));
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState((current) =>
          failActorCatalogRefresh(current, spacePath, errorMessage(error)),
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [spacePath]);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) => beginActorCatalogRefresh(current, spacePath));

    try {
      const snapshot = await refreshActorCatalog(spacePath);
      if (requestId !== requestIdRef.current) return;
      setState(completeActorCatalogRefresh(spacePath, snapshot));
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState((current) =>
        failActorCatalogRefresh(current, spacePath, errorMessage(error)),
      );
    }
  }, [spacePath]);

  return { refresh, state: currentState };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown actor catalog error";
}
