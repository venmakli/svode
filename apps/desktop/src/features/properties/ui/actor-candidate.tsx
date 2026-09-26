import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentAvatar, humanAvatar } from "@/features/identity";
import { cn } from "@/shared/lib/utils";

import { actorDisplayName } from "../lib/utils";
import type { ActorCandidate } from "../model/types";

export function ActorCandidateAvatar({ actor }: { actor: ActorCandidate }) {
  if (actor.kind === "agent") {
    return (
      <AgentAvatar
        size="sm"
        tone={actor.state === "ambiguous" ? "destructive" : "neutral"}
      />
    );
  }
  const avatar = humanAvatar(actor);
  return (
    <Avatar size="sm" className="shrink-0">
      <AvatarFallback className="text-[10px] font-medium" style={avatar.style}>
        {avatar.initials}
      </AvatarFallback>
    </Avatar>
  );
}

/** Avatar and name on one line; unresolved agent references keep the same geometry. */
export function ActorCandidateValue({
  actor,
  detail,
}: {
  actor: ActorCandidate;
  detail?: ReactNode;
}) {
  const state = actor.kind === "agent" ? actor.state : undefined;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <ActorCandidateAvatar actor={actor} />
      {state === "loading" ? (
        <>
          <Skeleton aria-hidden className="h-4 w-24" />
          <span className="sr-only">{actorDisplayName(actor)}</span>
        </>
      ) : (
        <span
          className={cn(
            "min-w-0 truncate",
            state === "missing" && "text-muted-foreground",
            (state === "ambiguous" || state === "error") && "text-destructive",
          )}
        >
          {actorDisplayName(actor)}
          {detail}
        </span>
      )}
    </span>
  );
}
