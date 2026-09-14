import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { humanAvatar } from "@/features/identity";

import type { ActorCatalogRow } from "../model/types";

export function ActorAvatar({
  actor,
  size = "default",
}: {
  actor: ActorCatalogRow;
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
