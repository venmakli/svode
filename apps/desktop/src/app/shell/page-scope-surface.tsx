import { useState } from "react";
import type { PageSurfaceLayout } from "@/features/page/app-shell";
import {
  PageAccessRecovery,
  usePageSurfaceSession,
} from "@/features/page/scope-surface";
import { useCollectionDetailController } from "@/features/collection/app-shell";
import { createPageOwner, ScopeSurfaceHost } from "@/features/scope-surfaces";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { createScopeContentRenderers } from "./scope-content-renderers";

interface PageScopeSurfaceProps extends PageSurfaceLayout {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  hasApp: boolean;
  sessionKey: number;
}

export function PageScopeSurface({
  contentPath,
  directoryPath,
  header,
  children,
  spaceId,
  spacePath,
  projectPath,
  hasApp,
  sessionKey,
}: PageScopeSurfaceProps) {
  const pageSurface = usePageSurfaceSession();
  const detailController = useCollectionDetailController();
  const owner = createPageOwner({
    contentPath,
    spaceId,
    spacePath,
    projectPath,
    status: "ready",
    ...(directoryPath
      ? { form: "folder", ownerPath: directoryPath, hasApp }
      : { form: "leaf" }),
  });
  const [ownerKeys, setOwnerKeys] = useState({
    current: owner.ownerKey,
    previous: owner.ownerKey,
  });
  if (ownerKeys.current !== owner.ownerKey) {
    setOwnerKeys({ current: owner.ownerKey, previous: ownerKeys.current });
  }

  const contributions = createScopeSurfaceContributions({
    ...createScopeContentRenderers({
      readOnly: pageSurface.readOnly,
      recovery: (
        <PageAccessRecovery className="mx-auto w-full max-w-5xl px-6 pb-4" />
      ),
    }),
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
      previousOwnerKey={ownerKeys.previous}
      prepareForSurfaceChange={async (currentSurfaceId) => {
        if (!(await detailController.prepareForNavigation())) return false;
        return currentSurfaceId === "readme"
          ? pageSurface.prepareForNavigation()
          : true;
      }}
    />
  );
}
