import { Skeleton } from "@/components/ui/skeleton";
import { AgentAvatar } from "@/features/identity";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import type { AgentActorReference } from "../model/agent-actor-reference";

export function agentActorReferenceLabel(reference: AgentActorReference) {
  switch (reference.status) {
    case "resolved":
      return reference.option.label;
    case "loading":
      return m.agent_actors_reference_loading();
    case "missing":
      return m.agent_actors_reference_missing();
    case "ambiguous":
      return m.agent_actors_reference_ambiguous();
    case "error":
      return m.agent_actors_reference_error();
  }
}

export function AgentActorReferenceValue({
  reference,
  showOwner = false,
}: {
  reference: AgentActorReference;
  showOwner?: boolean;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-2"
      data-agent-actor-reference={reference.status}
    >
      <AgentAvatar
        size="sm"
        tone={reference.status === "ambiguous" ? "destructive" : "neutral"}
      />
      {reference.status === "loading" ? (
        <>
          <Skeleton aria-hidden className="h-4 w-24" />
          <span className="sr-only">{agentActorReferenceLabel(reference)}</span>
        </>
      ) : (
        <span
          className={cn(
            "truncate",
            reference.status === "missing" && "text-muted-foreground",
            (reference.status === "ambiguous" ||
              reference.status === "error") &&
              "text-destructive",
          )}
        >
          {agentActorReferenceLabel(reference)}
          {showOwner && reference.status === "resolved" ? (
            <span className="text-muted-foreground">
              {" · "}
              {reference.option.ownerLabel}
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}
