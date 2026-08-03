import { useCallback, useEffect, useRef, useState } from "react";

import {
  listenAgentContextInvalidation,
  loadAgentContextInstructions,
  refreshAgentContextInstructionsSnapshot,
} from "../api/agent-context-api";
import {
  beginAgentContextRefresh,
  completeAgentContextRefresh,
  failAgentContextRefresh,
  type AgentContextCatalogState,
} from "../model/catalog-state";

const personalSourceRefreshIntervalMs = 30_000;

export function useAgentContextInstructions({
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
  const requestIdRef = useRef(0);
  const currentState =
    state.ownerKey === ownerKey && state.targetPath === spacePath
      ? state
      : ({ ownerKey, phase: "initial", targetPath: spacePath } as const);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    void loadAgentContextInstructions(projectPath, spacePath).then(
      (snapshot) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState(
          completeAgentContextRefresh(ownerKey, spacePath, snapshot),
        );
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState((current) =>
          failAgentContextRefresh(
            current,
            ownerKey,
            spacePath,
            errorMessage(error),
          ),
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [ownerKey, projectPath, spacePath]);

  const refresh = useCallback(
    async () => {
      const requestId = ++requestIdRef.current;
      setState((current) =>
        beginAgentContextRefresh(current, ownerKey, spacePath),
      );

      try {
        const snapshot = await refreshAgentContextInstructionsSnapshot(
          projectPath,
          spacePath,
        );
        if (requestId !== requestIdRef.current) return;
        setState(
          completeAgentContextRefresh(ownerKey, spacePath, snapshot),
        );
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setState((current) =>
          failAgentContextRefresh(
            current,
            ownerKey,
            spacePath,
            errorMessage(error),
          ),
        );
      }
    },
    [ownerKey, projectPath, spacePath],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenAgentContextInvalidation((payload) => {
      if (payload.spacePath === spacePath) void refresh();
    })
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh, spacePath]);

  const hasPersonalSources =
    currentState.phase === "ready" &&
    currentState.snapshot.hasPersonalSources;
  useEffect(() => {
    if (!hasPersonalSources) return;
    const interval = window.setInterval(() => {
      void refresh();
    }, personalSourceRefreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [hasPersonalSources, refresh]);

  return { refresh, state: currentState };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown Agent Context discovery error";
}
