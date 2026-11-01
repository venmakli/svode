import type { ChatAgents } from "@/features/agent-sessions/agent-settings-popover";
import * as m from "@/paraglide/messages.js";

import { useAgentActorBinding } from "../hooks/use-agent-actor-binding";
import type {
  AgentActorAgentOption,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { AgentActorBindingField } from "./agent-actor-binding-field";

/**
 * The Agent's detail: its binding row, whose popover shows the agent's
 * settings, values and mode from its last declarations without starting
 * it; changing them is the edit form's.
 */
export function AgentActorReadOnlyDetail({
  agents,
  draft,
  offers,
  onOpenAgentSettings,
  onRecheckOffers,
}: {
  agents: readonly AgentActorAgentOption[];
  draft: AgentActorDraft;
  offers: ChatAgents | null;
  onOpenAgentSettings(): void;
  onRecheckOffers(): void;
}) {
  const binding = useAgentActorBinding({
    agents,
    cwd: null,
    draft,
    editable: false,
    offers,
    onChange: () => undefined,
    onRecheck: onRecheckOffers,
  });
  return (
    <div
      className="flex min-h-0 flex-col gap-5"
      data-agent-actor-read-only-detail
    >
      <section className="flex flex-col gap-2" data-agent-actor-agent>
        <h3 className="text-sm font-medium">{m.agent_actors_agent_label()}</h3>
        <AgentActorBindingField
          binding={binding}
          onOpenAgentSettings={onOpenAgentSettings}
        />
      </section>
    </div>
  );
}
