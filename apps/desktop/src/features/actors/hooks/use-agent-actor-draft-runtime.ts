import { useEffect, useMemo, useState } from "react";

import { inspectAgentActorBinding } from "../api/agent-actors-api";
import type {
  AgentActorApprovalMode,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";
import type { AgentActorDraftRuntimePhase } from "../model/agent-actor-draft";

export interface AgentActorDraftRuntimeState {
  phase: AgentActorDraftRuntimePhase;
  runtime: Partial<Record<"claude-code" | "codex", AgentActorBindingRuntime>>;
}

export function useAgentActorDraftRuntime(draft: AgentActorDraft | null) {
  const [state, setState] = useState<{
    key: string;
    phase: AgentActorDraftRuntimePhase;
    runtime: Partial<Record<"claude-code" | "codex", AgentActorBindingRuntime>>;
  }>({ key: "", phase: "idle", runtime: {} });
  const key = useMemo(
    () => (draft ? JSON.stringify([draft.approvalMode, draft.adapters]) : ""),
    [draft],
  );

  useEffect(() => {
    let cancelled = false;
    if (!key) {
      queueMicrotask(() => {
        if (!cancelled) {
          setState({ key: "", phase: "idle", runtime: {} });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    const [approvalMode, adapters] = JSON.parse(key) as [
      AgentActorApprovalMode,
      AgentActorBinding[],
    ];
    queueMicrotask(() => {
      if (!cancelled) {
        setState({ key, phase: "loading", runtime: {} });
      }
    });
    void Promise.all(
      adapters.map(
        async (binding) =>
          [
            binding.adapter,
            await inspectAgentActorBinding(binding, approvalMode),
          ] as const,
      ),
    ).then(
      (entries) => {
        if (!cancelled) {
          setState({
            key,
            phase: "ready",
            runtime: Object.fromEntries(entries),
          });
        }
      },
      () => {
        if (!cancelled) setState({ key, phase: "error", runtime: {} });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!draft)
    return { phase: "idle", runtime: {} } satisfies AgentActorDraftRuntimeState;
  if (state.key !== key) {
    return {
      phase: "loading",
      runtime: {},
    } satisfies AgentActorDraftRuntimeState;
  }
  return { phase: state.phase, runtime: state.runtime };
}
