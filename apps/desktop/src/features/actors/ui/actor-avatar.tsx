import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { humanAvatar } from "@/features/identity";

import type { ActorCatalogItem } from "../model/types";

export function ActorAvatar({
  actor,
  size = "default",
}: {
  actor: ActorCatalogItem;
  size?: "default" | "sm" | "lg";
}) {
  const avatar = humanAvatar({
    name: actor.displayName,
    email: actor.canonicalEmail,
  });
  return (
    <Avatar className="rounded-lg after:rounded-lg" size={size}>
      <AvatarFallback className="rounded-lg font-medium" style={avatar.style}>
        {avatar.initials}
      </AvatarFallback>
    </Avatar>
  );
}
