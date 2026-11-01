import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SingleFlightRefreshCoordinator } from "@/shared/lib/single-flight-refresh-coordinator";

import {
  listenAgentActorCatalogInvalidated,
  loadAgentActors,
} from "../api/agent-actors-api";
import {
  beginAgentActorCatalogRefresh,
  failAgentActorCatalogRefresh,
  publishAgentActorCatalogSnapshot,
  type AgentActorCatalogState,
} from "../model/agent-actor-catalog-state";
import type { AgentActorCatalogSnapshot } from "../model/agent-actor-types";

const agentActorRefreshDebounceMs = 120;

interface ScopedAgentActorCatalogState {
  sourceKey: string;
  value: AgentActorCatalogState;
}

export function useAgentActorCatalog(
  projectPath: string,
  launchSpacePath: string,
) {
  const sourceKey = useMemo(
    () => JSON.stringify({ launchSpacePath, projectPath }),
    [launchSpacePath, projectPath],
  );
  const [scopedState, setScopedState] = useState<ScopedAgentActorCatalogState>({
    sourceKey,
    value: { phase: "initial" },
  });
  const state = useMemo<AgentActorCatalogState>(
    () =>
      scopedState.sourceKey === sourceKey
        ? scopedState.value
        : { phase: "initial" },
    [scopedState, sourceKey],
  );
  const coordinatorRef =
    useRef<SingleFlightRefreshCoordinator<AgentActorCatalogSnapshot> | null>(
      null,
    );

  useEffect(() => {
    const coordinator = new SingleFlightRefreshCoordinator({
      debounceMs: agentActorRefreshDebounceMs,
      load: () => loadAgentActors(projectPath, launchSpacePath),
      onFailure: (error) => {
        setScopedState((current) => ({
          sourceKey,
          value: failAgentActorCatalogRefresh(
            current.sourceKey === sourceKey
              ? current.value
              : { phase: "initial" },
            errorMessage(error),
          ),
        }));
      },
      onSuccess: (snapshot) => {
        setScopedState((current) => ({
          sourceKey,
          value: publishAgentActorCatalogSnapshot(
            current.sourceKey === sourceKey
              ? current.value
              : { phase: "initial" },
            snapshot,
          ),
        }));
      },
    });
    coordinatorRef.current = coordinator;
    void coordinator.loadInitial();

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentActorCatalogInvalidated((event) => {
      if (
        event.ownerPath !== launchSpacePath &&
        event.ownerPath !== projectPath
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
  }, [launchSpacePath, projectPath, sourceKey]);

  const refresh = useCallback(async () => {
    setScopedState((current) => ({
      sourceKey,
      value: beginAgentActorCatalogRefresh(
        current.sourceKey === sourceKey ? current.value : { phase: "initial" },
      ),
    }));
    await coordinatorRef.current?.retry();
  }, [sourceKey]);

  return { refresh, state };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown agent actor catalog error";
}
