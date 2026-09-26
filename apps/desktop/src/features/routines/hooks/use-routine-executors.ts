import { useEffect, useMemo, useState } from "react";

import { listenAgentActorCatalogInvalidated } from "@/features/actors";
import {
  EMPTY_AGENT_ACTOR_OPTIONS,
  loadAgentActorOptions,
  type AgentActorOptionCatalog,
  type AgentActorOptionsState,
} from "@/features/actors/agent-reference";

export function useRoutineExecutors(
  projectPath: string,
  launchSpacePath: string,
  enabled = true,
) {
  const [request, setRequest] = useState(0);
  const ownerKey = JSON.stringify([projectPath, launchSpacePath]);
  const requestKey = JSON.stringify([projectPath, launchSpacePath, request]);
  const [snapshot, setSnapshot] = useState<{
    catalog: AgentActorOptionCatalog;
    error: string | null;
    loading: boolean;
    ownerKey: string;
    requestKey: string;
  }>({
    catalog: EMPTY_AGENT_ACTOR_OPTIONS,
    error: null,
    loading: true,
    ownerKey: "",
    requestKey: "",
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadAgentActorOptions(projectPath, launchSpacePath).then(
      (catalog) => {
        if (!cancelled) {
          setSnapshot({
            catalog,
            error: null,
            loading: false,
            ownerKey,
            requestKey,
          });
        }
      },
      (reason: unknown) => {
        if (cancelled) return;
        setSnapshot({
          catalog: EMPTY_AGENT_ACTOR_OPTIONS,
          error:
            reason instanceof Error && reason.message
              ? reason.message
              : String(reason),
          loading: false,
          ownerKey,
          requestKey,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, launchSpacePath, ownerKey, projectPath, requestKey]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentActorCatalogInvalidated((event) => {
      if (
        event.ownerPath !== launchSpacePath &&
        event.ownerPath !== projectPath
      ) {
        return;
      }
      setRequest((current) => current + 1);
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
    };
  }, [enabled, launchSpacePath, projectPath]);

  const state = useMemo<AgentActorOptionsState>(() => {
    if (!enabled) return EMPTY_AGENT_ACTOR_OPTIONS;
    if (snapshot.requestKey === requestKey) {
      return {
        ...snapshot.catalog,
        error: snapshot.error,
        loading: snapshot.loading,
      };
    }
    return {
      ...(snapshot.ownerKey === ownerKey
        ? snapshot.catalog
        : EMPTY_AGENT_ACTOR_OPTIONS),
      error: null,
      loading: true,
    };
  }, [enabled, ownerKey, requestKey, snapshot]);

  return {
    retry: () => setRequest((current) => current + 1),
    state,
  };
}
