import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadRoutineCatalog,
  refreshRoutineCatalog,
  type RoutineOwnerInput,
} from "../api/routines-api";
import {
  beginRoutineCatalogRefresh,
  completeRoutineCatalogRefresh,
  failRoutineCatalogRefresh,
} from "../model/catalog-state";
import type {
  RoutineCatalogSnapshot,
  RoutineCatalogState,
} from "../model/types";

export function useRoutineCatalog(owner: RoutineOwnerInput) {
  const { ownerKind, ownerPath, projectPath, spaceId, spacePath } = owner;
  const [state, setState] = useState<RoutineCatalogState>({
    phase: "initial",
  });
  const requestIdRef = useRef(0);
  const source = useMemo<RoutineOwnerInput>(
    () => ({ ownerKind, ownerPath, projectPath, spaceId, spacePath }),
    [ownerKind, ownerPath, projectPath, spaceId, spacePath],
  );

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    setState({ phase: "initial" });
    void loadRoutineCatalog(source).then(
      (snapshot) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState(completeRoutineCatalogRefresh(snapshot));
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState((current) =>
          failRoutineCatalogRefresh(current, errorMessage(error)),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState(beginRoutineCatalogRefresh);
    try {
      const snapshot = await refreshRoutineCatalog(source);
      if (requestId !== requestIdRef.current) return null;
      setState(completeRoutineCatalogRefresh(snapshot));
      return snapshot;
    } catch (error) {
      if (requestId !== requestIdRef.current) return null;
      setState((current) =>
        failRoutineCatalogRefresh(current, errorMessage(error)),
      );
      return null;
    }
  }, [source]);

  const replaceSnapshot = useCallback((snapshot: RoutineCatalogSnapshot) => {
    ++requestIdRef.current;
    setState(completeRoutineCatalogRefresh(snapshot));
  }, []);

  return { refresh, replaceSnapshot, state };
}

export function routineErrorMessage(error: unknown) {
  return errorMessage(error);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown routines error";
}
