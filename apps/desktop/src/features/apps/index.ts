import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import type { AppOwner } from "./model/types";

export { AppSurface } from "./ui/app-surface";
export type {
  AppManifestDiagnostic,
  AppOwner,
  AppSession,
} from "./model/types";

export function appOwnerFromScopeOwner(owner: ScopeOwnerRef): AppOwner {
  return {
    projectPath: owner.projectPath,
    spaceId: owner.spaceId,
    spacePath: owner.spacePath,
    ownerPath: owner.ownerPath,
  };
}
