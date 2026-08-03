import type { ActorCatalogRow } from "../model/types";
import { ActorActivityProfile } from "./actor-activity-profile";
import { ActorGitIdentities } from "./actor-git-identities";

export function ActorDetail({
  actor,
  catalogGeneration = 0,
  spacePath,
}: {
  actor: ActorCatalogRow;
  catalogGeneration?: number;
  spacePath: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-6"
      data-actor-detail={actor.canonicalEmail}
    >
      <ActorActivityProfile
        key={`${spacePath}\0${actor.canonicalEmail}\0${catalogGeneration}`}
        actor={actor}
        spacePath={spacePath}
      />
      <ActorGitIdentities actor={actor} />
    </div>
  );
}
