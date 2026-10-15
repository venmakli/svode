import { useCallback, useEffect, useRef, useState } from "react";

import {
  listenAgentContextEnabledAgentsChanged,
  listenAgentContextInvalidation,
  loadAgentContext,
  refreshAgentContextSnapshot,
} from "../api/agent-context-api";
import {
  beginAgentContextRetry,
  completeAgentContextRefresh,
  failAgentContextRefresh,
  type AgentContextCatalogState,
} from "../model/catalog-state";
import type { AgentContextSnapshot } from "../model/types";
import { AgentContextRefreshCoordinator } from "./agent-context-refresh-coordinator";

const personalSourceRefreshIntervalMs = 30_000;
const projectSourceRefreshDebounceMs = 120;

export function useAgentContext({
  ownerKey,
  projectPath,
  spacePath,
}: {
  ownerKey: string;
  projectPath: string;
  spacePath: string;
}) {
  const [state, setState] = useState<AgentContextCatalogState>({
    ownerKey,
    phase: "initial",
    targetPath: spacePath,
  });
  const coordinatorRef =
    useRef<AgentContextRefreshCoordinator<AgentContextSnapshot> | null>(null);
  const currentState =
    state.ownerKey === ownerKey && state.targetPath === spacePath
      ? state
      : ({ ownerKey, phase: "initial", targetPath: spacePath } as const);

  useEffect(() => {
    const coordinator = new AgentContextRefreshCoordinator({
      debounceMs: projectSourceRefreshDebounceMs,
      load: (request) =>
        request === "initial"
          ? loadAgentContext(projectPath, spacePath)
          : refreshAgentContextSnapshot(projectPath, spacePath),
      onFailure: (error) => {
        setState((current) =>
          failAgentContextRefresh(
            current,
            ownerKey,
            spacePath,
            errorMessage(error),
          ),
        );
      },
      onSuccess: (snapshot) => {
        setState((current) =>
          completeAgentContextRefresh(current, ownerKey, spacePath, snapshot),
        );
      },
    });
    coordinatorRef.current = coordinator;
    coordinator.loadInitial();

    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [ownerKey, projectPath, spacePath]);

  const retry = useCallback(() => {
    setState((current) => beginAgentContextRetry(current, ownerKey, spacePath));
    coordinatorRef.current?.retry();
  }, [ownerKey, spacePath]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const follow = (listen: Promise<() => void>) => {
      void listen
        .then((nextUnlisten) => {
          if (disposed) nextUnlisten();
          else unlisteners.push(nextUnlisten);
        })
        .catch(() => undefined);
    };
    follow(
      listenAgentContextInvalidation((payload) => {
        if (payload.spacePath === spacePath) {
          coordinator.invalidate();
        }
      }),
    );
    // Enabling or disabling an agent rebuilds the target's set.
    follow(
      listenAgentContextEnabledAgentsChanged(() => coordinator.invalidate()),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [spacePath]);

  const hasPersonalSources =
    currentState.phase === "ready" && currentState.snapshot.hasPersonalSources;
  useEffect(() => {
    if (!hasPersonalSources) return;
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    const interval = window.setInterval(() => {
      coordinator.invalidate();
    }, personalSourceRefreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [hasPersonalSources]);

  return { retry, state: currentState };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown Agent Context discovery error";
}
