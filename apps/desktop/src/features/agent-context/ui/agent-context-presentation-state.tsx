import { Button } from "@/components/ui/button";
import type { CollectionCorePresentationState } from "@/features/collection/core";
import * as m from "@/paraglide/messages.js";

import type { AgentContextCatalogState } from "../model/catalog-state";

export function toAgentContextPresentationState<Row>(
  state: AgentContextCatalogState,
  selectRows: (
    snapshot: Extract<AgentContextCatalogState, { phase: "ready" }>["snapshot"],
  ) => readonly Row[],
  sourceEmpty: React.ReactNode,
  onRetry: () => void,
): CollectionCorePresentationState<Row> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: (
        <div className="flex flex-col items-start gap-2">
          <span className="flex flex-col gap-1">
            <strong>{m.agent_context_blocking_title()}</strong>
            <span>{state.error}</span>
          </span>
          <AgentContextRetryButton
            disabled={state.retrying}
            onRetry={onRetry}
          />
        </div>
      ),
      phase: "blocking_error",
    };
  }

  return {
    phase: "ready",
    rows: selectRows(state.snapshot),
    sourceEmpty,
  };
}

function AgentContextRetryButton({
  disabled,
  onRetry,
}: {
  disabled: boolean;
  onRetry(): void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onRetry}
    >
      {m.agent_context_retry()}
    </Button>
  );
}
