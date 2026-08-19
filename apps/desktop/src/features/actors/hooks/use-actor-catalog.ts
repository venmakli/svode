import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SingleFlightRefreshCoordinator } from "@/shared/lib/single-flight-refresh-coordinator";

import {
  listenActorCatalogInvalidated,
  loadActorCatalog,
  refreshActorCatalog,
} from "../api/actors-api";
import {
  beginActorCatalogRefresh,
  failActorCatalogRefresh,
  publishActorCatalogSnapshot,
  type ActorCatalogState,
} from "../model/catalog-state";
import type { ActorCatalogSnapshot } from "../model/types";

const actorRefreshDebounceMs = 120;

export function useActorCatalog(spacePath: string) {
  const [state, setState] = useState<ActorCatalogState>({
    phase: "initial",
    spacePath,
  });
  const coordinatorRef =
    useRef<SingleFlightRefreshCoordinator<ActorCatalogSnapshot> | null>(null);
  const currentState = useMemo<ActorCatalogState>(
    () =>
      state.spacePath === spacePath ? state : { phase: "initial", spacePath },
    [spacePath, state],
  );
  const snapshotRef = useRef<ActorCatalogSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    const pendingRepositoryEvents = new Map<string, number | null>();
    const coordinator = new SingleFlightRefreshCoordinator({
      debounceMs: actorRefreshDebounceMs,
      load: (request) =>
        request === "initial"
          ? loadActorCatalog(spacePath)
          : refreshActorCatalog(spacePath),
      onFailure: (error) => {
        setState((current) =>
          failActorCatalogRefresh(current, spacePath, errorMessage(error)),
        );
      },
      onSuccess: (snapshot) => {
        snapshotRef.current = snapshot;
        const pendingGeneration = pendingRepositoryEvents.get(
          snapshot.repositoryId,
        );
        const needsTrailingLoad =
          pendingRepositoryEvents.has(snapshot.repositoryId) &&
          (pendingGeneration === null ||
            (pendingGeneration !== undefined &&
              pendingGeneration > snapshot.generation));
        pendingRepositoryEvents.clear();
        setState((current) =>
          publishActorCatalogSnapshot(current, spacePath, snapshot),
        );
        if (needsTrailingLoad) void coordinator.invalidate();
      },
    });
    coordinatorRef.current = coordinator;
    void coordinator.loadInitial();

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenActorCatalogInvalidated((event) => {
      const snapshot = snapshotRef.current;
      if (!snapshot) {
        const pendingGeneration = pendingRepositoryEvents.get(
          event.repositoryId,
        );
        pendingRepositoryEvents.set(
          event.repositoryId,
          event.generation === undefined || pendingGeneration === null
            ? null
            : Math.max(pendingGeneration ?? 0, event.generation),
        );
        return;
      }
      if (
        event.repositoryId !== snapshot.repositoryId ||
        (event.generation !== undefined &&
          event.generation <= snapshot.generation)
      ) {
        return;
      }
      void coordinator.invalidate();
    }).then(
      (registeredUnlisten) => {
        if (disposed) registeredUnlisten();
        else unlisten = registeredUnlisten;
      },
      () => undefined,
    );

    return () => {
      disposed = true;
      unlisten?.();
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [spacePath]);

  const refresh = useCallback(async () => {
    setState((current) => beginActorCatalogRefresh(current, spacePath));
    await coordinatorRef.current?.retry();
  }, [spacePath]);

  const replaceSnapshot = useCallback(
    (snapshot: ActorCatalogSnapshot) => {
      coordinatorRef.current?.supersede();
      snapshotRef.current = snapshot;
      setState((current) =>
        publishActorCatalogSnapshot(current, spacePath, snapshot),
      );
    },
    [spacePath],
  );

  return { refresh, replaceSnapshot, state: currentState };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown actor catalog error";
}
