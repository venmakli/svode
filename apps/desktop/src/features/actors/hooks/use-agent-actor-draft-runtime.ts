import { useEffect, useMemo, useState } from "react";

import { inspectAgentActorBinding } from "../api/agent-actors-api";
import type {
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";

export function useAgentActorDraftRuntime(draft: AgentActorDraft | null) {
  const [state, setState] = useState<{
    key: string;
    runtime: Partial<Record<"claude-code" | "codex", AgentActorBindingRuntime>>;
  }>({ key: "", runtime: {} });
  const key = useMemo(
    () => (draft ? JSON.stringify([draft.approvalMode, draft.adapters]) : ""),
    [draft],
  );

  useEffect(() => {
    if (!draft) {
      return;
    }
    let cancelled = false;
    void Promise.all(
      draft.adapters.map(
        async (binding) =>
          [
            binding.adapter,
            await inspectAgentActorBinding(binding, draft.approvalMode),
          ] as const,
      ),
    ).then(
      (entries) => {
        if (!cancelled) setState({ key, runtime: Object.fromEntries(entries) });
      },
      () => {
        if (!cancelled) setState({ key, runtime: {} });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [draft, key]);

  return state.key === key ? state.runtime : {};
}
