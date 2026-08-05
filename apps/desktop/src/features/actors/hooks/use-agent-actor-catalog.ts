import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  diagnoseAgentActorAdapter,
  loadAgentActors,
  runtimeKey,
} from "../api/agent-actors-api";
import { resolveAgentActorRuntimeStatus } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorBindingValidation,
  AgentActorCatalogSnapshot,
} from "../model/agent-actor-types";

type AgentActorCatalogState =
  | { phase: "initial" }
  | { phase: "blocking_error"; error: string }
  | {
      phase: "ready";
      snapshot: AgentActorCatalogSnapshot;
      refreshing: boolean;
      refreshError: string | null;
    };

export function useAgentActorCatalog(
  projectPath: string,
  launchSpacePath: string,
) {
  const [state, setState] = useState<AgentActorCatalogState>({
    phase: "initial",
  });
  const [diagnostics, setDiagnostics] = useState<
    Partial<Record<"claude-code" | "codex", AgentActorAdapterDiagnostic>>
  >({});
  const [pendingAdapter, setPendingAdapter] = useState<
    "claude-code" | "codex" | null
  >(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (refreshing: boolean) => {
      const requestId = ++requestIdRef.current;
      if (refreshing) {
        setState((current) =>
          current.phase === "ready"
            ? { ...current, refreshing: true, refreshError: null }
            : current,
        );
      }
      try {
        const snapshot = await loadAgentActors(projectPath, launchSpacePath);
        if (requestId !== requestIdRef.current) return;
        setState({
          phase: "ready",
          refreshError: null,
          refreshing: false,
          snapshot,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        const message = errorMessage(error);
        setState((current) =>
          refreshing && current.phase === "ready"
            ? { ...current, refreshing: false, refreshError: message }
            : { phase: "blocking_error", error: message },
        );
      }
    },
    [launchSpacePath, projectPath],
  );

  useEffect(() => {
    setState({ phase: "initial" });
    setDiagnostics({});
    void load(false);
  }, [load]);

  const diagnose = useCallback(
    async (adapter: "claude-code" | "codex") => {
      if (pendingAdapter) return null;
      setPendingAdapter(adapter);
      try {
        const diagnostic = await diagnoseAgentActorAdapter(
          launchSpacePath,
          adapter,
        );
        setDiagnostics((current) => ({ ...current, [adapter]: diagnostic }));
        return diagnostic;
      } finally {
        setPendingAdapter(null);
      }
    },
    [launchSpacePath, pendingAdapter],
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
  const refresh = useCallback(() => load(true), [load]);

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
