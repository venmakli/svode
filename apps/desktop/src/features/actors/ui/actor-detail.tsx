import type { ActorCatalogItem } from "../model/types";
import { ActorActivityProfile } from "./actor-activity-profile";

/** The body of a person's screen: the activity profile. */
export function ActorDetail({
  actor,
  catalogGeneration = 0,
  spacePath,
}: {
  actor: ActorCatalogItem;
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
    </div>
  );
}
