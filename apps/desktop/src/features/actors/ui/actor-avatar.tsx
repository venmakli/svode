import { Avatar, AvatarFallback } from "@/components/ui/avatar";

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
    <Avatar size={size}>
      <AvatarFallback>{actorInitials(actor)}</AvatarFallback>
    </Avatar>
  );
}
