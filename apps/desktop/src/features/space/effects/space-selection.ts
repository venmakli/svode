import { openScopeOwner } from "@/features/artifact";

export function openScopeHomeSelection(spaceId: string) {
  openScopeOwner({ kind: "space", spaceId });
}
