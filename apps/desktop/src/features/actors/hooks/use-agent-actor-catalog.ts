import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SingleFlightRefreshCoordinator } from "@/shared/lib/single-flight-refresh-coordinator";

import {
  diagnoseAgentActorAdapter,
  listenAgentActorCatalogInvalidated,
  loadAgentActors,
  runtimeKey,
} from "../api/agent-actors-api";
import {
  beginAgentActorCatalogRefresh,
  failAgentActorCatalogRefresh,
  publishAgentActorCatalogSnapshot,
  type AgentActorCatalogState,
} from "../model/agent-actor-catalog-state";
import { resolveAgentActorRuntimeStatus } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorBindingValidation,
  AgentActorCatalogSnapshot,
} from "../model/agent-actor-types";

const agentActorRefreshDebounceMs = 120;

interface ScopedAgentActorCatalogState {
  sourceKey: string;
  value: AgentActorCatalogState;
}

interface ScopedAgentActorDiagnostics {
  sourceKey: string;
  value: Partial<Record<"claude-code" | "codex", AgentActorAdapterDiagnostic>>;
}

interface ScopedPendingAdapter {
  sourceKey: string;
  value: "claude-code" | "codex" | null;
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
  const [scopedDiagnostics, setScopedDiagnostics] =
    useState<ScopedAgentActorDiagnostics>({
      sourceKey,
      value: {},
    });
  const diagnostics = useMemo(
    () =>
      scopedDiagnostics.sourceKey === sourceKey ? scopedDiagnostics.value : {},
    [scopedDiagnostics, sourceKey],
  );
  const [scopedPendingAdapter, setScopedPendingAdapter] =
    useState<ScopedPendingAdapter>({ sourceKey, value: null });
  const pendingAdapter =
    scopedPendingAdapter.sourceKey === sourceKey
      ? scopedPendingAdapter.value
      : null;
  const activeSourceKeyRef = useRef(sourceKey);
  activeSourceKeyRef.current = sourceKey;
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

  const diagnose = useCallback(
    async (adapter: "claude-code" | "codex") => {
      if (pendingAdapter) return null;
      setScopedPendingAdapter({ sourceKey, value: adapter });
      try {
        const diagnostic = await diagnoseAgentActorAdapter(
          launchSpacePath,
          adapter,
        );
        if (activeSourceKeyRef.current !== sourceKey) return diagnostic;
        setScopedDiagnostics((current) => ({
          sourceKey,
          value: {
            ...(current.sourceKey === sourceKey ? current.value : {}),
            [adapter]: diagnostic,
          },
        }));
        return diagnostic;
      } finally {
        setScopedPendingAdapter((current) =>
          current.sourceKey === sourceKey
            ? { sourceKey, value: null }
            : current,
        );
      }
    },
    [launchSpacePath, pendingAdapter, sourceKey],
  );

  const projectedState = useMemo<AgentActorCatalogState>(() => {
    if (state.phase !== "ready") return state;
    const rows = state.snapshot.rows.map((row) => {
      const runtime =
        state.snapshot.bindingRuntime[runtimeKey(row.ownerPath, row.id)] ?? [];
      const validations: Partial<
        Record<"claude-code" | "codex", AgentActorBindingValidation>
      > = {};
      row.adapters.forEach((binding, index) => {
        const validation = runtime[index]?.validation;
        if (validation) validations[binding.adapter] = validation;
      });
      return Object.freeze({
        ...row,
        runtimeStatus: resolveAgentActorRuntimeStatus({
          bindings: row.adapters,
          diagnostics,
          validations,
        }),
      });
    });
    return {
      ...state,
      snapshot: Object.freeze({
        ...state.snapshot,
        rows: Object.freeze(rows),
      }),
    };
  }, [diagnostics, state]);

  const refresh = useCallback(async () => {
    setScopedState((current) => ({
      sourceKey,
      value: beginAgentActorCatalogRefresh(
        current.sourceKey === sourceKey ? current.value : { phase: "initial" },
      ),
    }));
    await coordinatorRef.current?.retry();
  }, [sourceKey]);

  return {
    diagnose,
    diagnostics,
    pendingAdapter,
    refresh,
    state: projectedState,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown agent actor catalog error";
}
