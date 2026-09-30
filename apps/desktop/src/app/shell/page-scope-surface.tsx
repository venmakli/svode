import { useActiveContentSelection } from "@/features/artifact";
import { useState } from "react";
import { usePublishMainChangesTarget } from "@/features/changes";
import type { PageSurfaceLayout } from "@/features/page/app-shell";
import {
  usePageDetailContext,
  usePageSurfaceSession,
} from "@/features/page/scope-surface";
import { useCollectionDetailController } from "@/features/collection/app-shell";
import {
  ScopeSurfaceHost,
  type ScopeOwnerRef,
} from "@/features/scope-surfaces";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { createScopeContentRenderers } from "./scope-content-renderers";

interface PageScopeSurfaceProps extends PageSurfaceLayout {
  owner: ScopeOwnerRef;
  sessionKey: number;
}

export function PageScopeSurface({
  owner,
  header,
  children,
  sessionKey,
}: PageScopeSurfaceProps) {
  const { selection } = useActiveContentSelection();
  const pageSurface = usePageSurfaceSession();
  const detail = usePageDetailContext();
  const detailController = useCollectionDetailController();
  const [ownerKeys, setOwnerKeys] = useState({
    current: owner.ownerKey,
    previous: owner.ownerKey,
  });
  if (ownerKeys.current !== owner.ownerKey) {
    setOwnerKeys({ current: owner.ownerKey, previous: ownerKeys.current });
  }

  usePublishMainChangesTarget(
    detail.page
      ? {
          kind: "page",
          projectPath: owner.projectPath,
          sessionKey,
          sourceShape:
            owner.identityKind === "page-file" ? "file" : "directory",
          spacePath: owner.spacePath,
          path: detail.page.path,
          name: detail.page.meta.title,
        }
      : null,
  );

  const contributions = createScopeSurfaceContributions({
    ...createScopeContentRenderers({ readOnly: pageSurface.readOnly }),
    readme: () => children,
  });

  return (
    <ScopeSurfaceHost
      owner={owner}
      presentation="full"
      header={header}
      contributions={contributions}
      sessionKey={sessionKey}
      openRequestKey={sessionKey}
      openIntent={
        selection?.kind === "artifact"
          ? selection.request.intent.scopeOpenIntent
          : undefined
      }
      previousOwnerKey={ownerKeys.previous}
      prepareForSurfaceChange={async (currentSurfaceId) => {
        if (!(await detailController.close())) return false;
        return currentSurfaceId === "readme"
          ? pageSurface.prepareForNavigation()
          : true;
      }}
    />
  );
}
