import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listenAgentActorCatalogInvalidated } from "@/features/actors";
import { SingleFlightRefreshCoordinator } from "@/shared/lib/single-flight-refresh-coordinator";

import {
  listenRoutineCatalogInvalidated,
  loadRoutineCatalog,
  refreshRoutineCatalog,
  type RoutineOwnerInput,
} from "../api/routines-api";
import {
  beginRoutineCatalogRefresh,
  failRoutineCatalogRefresh,
  publishRoutineCatalogSnapshot,
} from "../model/catalog-state";
import type {
  RoutineCatalogSnapshot,
  RoutineCatalogState,
} from "../model/types";

const routineRefreshDebounceMs = 120;

interface ScopedRoutineCatalogState {
  sourceKey: string;
  value: RoutineCatalogState;
}

export function useRoutineCatalog(owner: RoutineOwnerInput) {
  const { ownerKind, ownerPath, projectPath, spaceId, spacePath } = owner;
  const source = useMemo<RoutineOwnerInput>(
    () => ({ ownerKind, ownerPath, projectPath, spaceId, spacePath }),
    [ownerKind, ownerPath, projectPath, spaceId, spacePath],
  );
  const sourceKey = useMemo(() => JSON.stringify(source), [source]);
  const [scopedState, setScopedState] = useState<ScopedRoutineCatalogState>({
    sourceKey,
    value: { phase: "initial" },
  });
  const state = useMemo<RoutineCatalogState>(
    () =>
      scopedState.sourceKey === sourceKey
        ? scopedState.value
        : { phase: "initial" },
    [scopedState, sourceKey],
  );
  const coordinatorRef =
    useRef<SingleFlightRefreshCoordinator<RoutineCatalogSnapshot> | null>(null);
  const snapshotRef = useRef<RoutineCatalogSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    const pendingOwnerEvents = new Set<string>();
    const coordinator = new SingleFlightRefreshCoordinator({
      debounceMs: routineRefreshDebounceMs,
      load: (request) =>
        request === "initial"
          ? loadRoutineCatalog(source)
          : refreshRoutineCatalog(source),
      onFailure: (error) => {
        setScopedState((current) => ({
          sourceKey,
          value: failRoutineCatalogRefresh(
            current.sourceKey === sourceKey
              ? current.value
              : { phase: "initial" },
            errorMessage(error),
          ),
        }));
      },
      onSuccess: (snapshot) => {
        snapshotRef.current = snapshot;
        const needsTrailingLoad = pendingOwnerEvents.has(
          routineOwnerEventKey(snapshot.resolvedOwnerKind, snapshot.ownerPath),
        );
        pendingOwnerEvents.clear();
        setScopedState((current) => ({
          sourceKey,
          value: publishRoutineCatalogSnapshot(
            current.sourceKey === sourceKey
              ? current.value
              : { phase: "initial" },
            snapshot,
          ),
        }));
        if (needsTrailingLoad) void coordinator.invalidate();
      },
    });
    coordinatorRef.current = coordinator;
    void coordinator.loadInitial();

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = (promise: Promise<() => void>) => {
      void promise.then(
        (unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        },
        () => undefined,
      );
    };
    register(
      listenRoutineCatalogInvalidated((event) => {
        if (event.projectPath !== projectPath || event.spacePath !== spacePath)
          return;
        const snapshot = snapshotRef.current;
        if (!snapshot) {
          pendingOwnerEvents.add(
            routineOwnerEventKey(event.ownerKind, event.ownerPath),
          );
          return;
        }
        if (
          event.ownerKind !== snapshot.resolvedOwnerKind ||
          event.ownerPath !== snapshot.ownerPath
        )
          return;
        void coordinator.invalidate();
      }),
    );
    register(
      listenAgentActorCatalogInvalidated((event) => {
        if (event.ownerPath !== projectPath && event.ownerPath !== spacePath) {
          return;
        }
        const snapshot = snapshotRef.current;
        if (
          snapshot &&
          !snapshot.rows.some(
            (row) => row.definition?.action.type === "run_agent",
          )
        ) {
          return;
        }
        void coordinator.invalidate();
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [projectPath, source, sourceKey, spacePath]);

  const refresh = useCallback(() => {
    setScopedState((current) => ({
      sourceKey,
      value: beginRoutineCatalogRefresh(
        current.sourceKey === sourceKey ? current.value : { phase: "initial" },
      ),
    }));
    return coordinatorRef.current?.retry() ?? Promise.resolve(null);
  }, [sourceKey]);

  const replaceSnapshot = useCallback(
    (snapshot: RoutineCatalogSnapshot) => {
      coordinatorRef.current?.supersede();
      snapshotRef.current = snapshot;
      setScopedState((current) => ({
        sourceKey,
        value: publishRoutineCatalogSnapshot(
          current.sourceKey === sourceKey
            ? current.value
            : { phase: "initial" },
          snapshot,
        ),
      }));
    },
    [sourceKey],
  );

  return { refresh, replaceSnapshot, state };
}

export function routineErrorMessage(error: unknown) {
  return errorMessage(error);
}

function routineOwnerEventKey(ownerKind: string, ownerPath: string) {
  return JSON.stringify([ownerKind, ownerPath]);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown routines error";
}
