import { useMemo, useState } from "react";
import { useOpenScopeOwner } from "@/features/artifact";
import type { AttachmentOwnerPeekContext } from "@/features/attachments";
import type {
  CollectionRouteState,
  CalendarScope,
} from "@/features/collection/app-shell";
import {
  createAppDirectoryOwner,
  createCollectionDirectoryOwner,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";

import { useCollectionRouteState } from "./hooks/use-collection-route-state";
import { ScopeSurfacePage } from "./scope-surface-page";

export function AttachmentOwnerPeek({
  target,
  spaceId,
  renderActions,
  registerCloseGuard,
}: AttachmentOwnerPeekContext) {
  const { row } = target;
  const openOwner = useOpenScopeOwner();
  const fullPageRoute = useCollectionRouteState();
  const [surfaceId, setSurfaceId] = useState<ScopeSurfaceId>(
    row.kind === "app" ? "app" : "readme",
  );
  const [viewName, setViewName] = useState<string | null>(null);
  const [calendarScope, setCalendarScope] = useState<CalendarScope | null>(
    null,
  );
  const routeState = useMemo<CollectionRouteState>(
    () => ({
      viewName,
      onViewNameChange: setViewName,
      calendarScope,
      onCalendarScopeChange: setCalendarScope,
    }),
    [viewName, calendarScope],
  );
  const facts = {
    projectPath: target.owner.projectPath,
    spacePath: target.owner.spacePath,
    spaceId,
    ownerPath: row.ownerPath!,
    status: "ready" as const,
    hasApp: row.hasApp,
  };
  const owner =
    row.kind === "collection"
      ? createCollectionDirectoryOwner({ ...facts, hasSchema: true })
      : createAppDirectoryOwner(facts);
  if (row.contentPath) owner.readmePath = row.contentPath;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end px-2 pb-2">
        {renderActions(() => {
          if (surfaceId === "collection") {
            fullPageRoute.onViewNameChange(viewName);
            if (calendarScope)
              fullPageRoute.onCalendarScopeChange(calendarScope);
          }
          openOwner(
            {
              kind: row.kind === "collection" ? "collection" : "app-directory",
              path: row.ownerPath!,
              spaceId,
            },
            { scopeOpenIntent: { kind: "target", surfaceId } },
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        <ScopeSurfacePage
          owner={owner}
          presentation="compact"
          routeState={routeState}
          compactSurfaceState={{ surfaceId, onSurfaceIdChange: setSurfaceId }}
          sessionKey={row.key}
          fallbackTitle={row.displayName}
          fallbackIcon={row.icon}
          registerNavigationGuard={registerCloseGuard}
        />
      </div>
    </div>
  );
}
