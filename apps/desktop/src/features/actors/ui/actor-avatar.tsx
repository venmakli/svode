import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarColorFromEmail } from "@/features/identity";

import { actorInitials } from "../model/actor-values";
import type { ActorCatalogRow } from "../model/types";

export function ActorAvatar({
  actor,
  size = "default",
}: {
  actor: ActorCatalogRow;
  size?: "default" | "sm" | "lg";
}) {
  return (
    <Avatar className="rounded-lg after:rounded-lg" size={size}>
      <AvatarFallback
        className="rounded-lg font-medium text-white"
        style={{ backgroundColor: avatarColorFromEmail(actor.canonicalEmail) }}
      >
        {actorInitials(actor)}
      </AvatarFallback>
    </Avatar>
  );
}
