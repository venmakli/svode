import {
  listActors,
  type ActorCandidateDto,
} from "@/platform/properties/properties-api";
import type { ActorCandidate } from "@/features/properties";

export async function listCollectionActors(spacePath: string, allTime = false) {
  return (await listActors(spacePath, allTime)).map(toActorCandidate);
}

function toActorCandidate(actor: ActorCandidateDto): ActorCandidate {
  return {
    email: actor.email,
    name: actor.name,
    lastCommitAt: actor.lastCommitAt ?? actor.last_commit_at ?? null,
    commitCount: actor.commitCount ?? actor.commit_count ?? 0,
    isMe: actor.isMe ?? actor.is_me ?? false,
  };
}
