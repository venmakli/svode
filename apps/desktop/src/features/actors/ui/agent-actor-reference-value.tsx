import { ActorCandidateValue } from "@/features/properties/display";

import { agentActorCandidate } from "../lib/agent-actor-candidates";
import type { AgentActorReference } from "../model/agent-actor-reference";

export function AgentActorReferenceValue({
  reference,
  showOwner = false,
}: {
  reference: AgentActorReference;
  showOwner?: boolean;
}) {
  return (
    <span
      className="flex min-w-0"
      data-agent-actor-reference={reference.status}
    >
      <ActorCandidateValue
        actor={agentActorCandidate(reference)}
        detail={
          showOwner && reference.status === "resolved" ? (
            <span className="text-muted-foreground">
              {" · "}
              {reference.option.ownerLabel}
            </span>
          ) : null
        }
      />
    </span>
  );
}
