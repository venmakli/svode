import { Alert, AlertDescription } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import { bindingAgent } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorDraft,
  AgentAdapterId,
} from "../model/agent-actor-types";
import { agentActorBindingLabel } from "./agent-actor-copy";
import { AgentAdapterCard } from "./agent-adapter-card";

export function AgentActorReadOnlyDetail({
  agents,
  diagnostics,
  draft,
  pendingAdapter,
  onCheck,
}: {
  agents: readonly AgentActorAgentOption[];
  diagnostics: Readonly<
    Partial<Record<AgentAdapterId, AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  pendingAdapter: AgentAdapterId | null;
  onCheck(adapter: AgentAdapterId): void;
}) {
  const agent = bindingAgent(draft.binding);
  const label = agentActorBindingLabel(draft.binding, agents);
  const known = agent !== null && agents.some((option) => option.id === agent);
  return (
    <div
      className="flex min-h-0 flex-col gap-5"
      data-agent-actor-read-only-detail
    >
      <section className="flex flex-col gap-2" data-agent-actor-adapters>
        <h3 className="text-sm font-medium">{m.agent_actors_agent_label()}</h3>
        {agent !== null && known ? (
          <AgentAdapterCard
            agent={agent}
            checkDisabled={pendingAdapter !== null}
            diagnostic={diagnostics[agent]}
            label={label}
            pending={pendingAdapter === agent}
            readOnly={false}
            onCheck={() => onCheck(agent)}
          />
        ) : (
          <p className="text-sm" data-agent-actor-binding>
            {label}
          </p>
        )}
        {agent !== null && !known ? (
          <Alert variant="destructive" data-agent-adapter-unknown>
            <AlertDescription>
              {m.agent_actors_adapter_unknown()}
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
    </div>
  );
}
