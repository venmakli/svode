import { Button } from "@/components/ui/button";
import type { CollectionPresentationState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import type { AgentContextCatalogState } from "../model/catalog-state";
import type { AgentContextItem } from "../model/types";

/**
 * The state of one preset. Without an enabled agent the set holds only
 * project items, and the one hint above them leads to Providers.
 */
export function toAgentContextPresentationState(
  state: AgentContextCatalogState,
  sourceEmpty: React.ReactNode,
  onRetry: () => void,
  onOpenProviders?: () => void,
): CollectionPresentationState<AgentContextItem> {
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
    ...(state.snapshot.enabledAgents.length === 0
      ? { attention: <NoEnabledAgentsHint onOpenProviders={onOpenProviders} /> }
      : {}),
    phase: "ready",
    rows: state.snapshot.items,
    sourceEmpty,
  };
}

function NoEnabledAgentsHint({
  onOpenProviders,
}: {
  onOpenProviders?: () => void;
}) {
  return (
    <span
      className="flex flex-col items-start gap-2"
      data-agent-context-no-enabled-agents
    >
      <span>{m.agent_context_no_enabled_agents()}</span>
      {onOpenProviders ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenProviders}
        >
          {m.agent_context_open_providers()}
        </Button>
      ) : null}
    </span>
  );
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
