import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useOpenScopeOwner,
  prepareActiveContentDeactivation,
} from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import type {
  CalendarScope,
  CollectionRouteState,
} from "@/features/collection/app-shell";
import {
  usePeekOwner,
  type ScopePeekContext,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";
import { useCollectionRouteState } from "./hooks/use-collection-route-state";
import { ScopeSurfacePage } from "./scope-surface-page";

export function CompactScopePeek(props: ScopePeekContext) {
  const [pathState, setPathState] = useState({
    input: props.path,
    current: props.path,
  });
  if (pathState.input !== props.path)
    setPathState({ input: props.path, current: props.path });
  const path = pathState.input === props.path ? pathState.current : props.path;
  const { owner, error, retry } = usePeekOwner({
    ...props,
    path,
    directory: props.directory && path === props.path,
  });
  const [surfaceId, setSurfaceId] = useState<ScopeSurfaceId | null>(null);
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
  const fullRoute = useCollectionRouteState();
  const openOwner = useOpenScopeOwner();
  const openPage = useOpenPage();
  if (owner && surfaceId === null)
    setSurfaceId(owner.identityKind === "app-directory" ? "app" : "readme");
  if (!owner)
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex shrink-0 justify-end px-2 pb-2">
          {props.renderActions(async () => false, null)}
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              <Button onClick={retry}>{m.attachments_retry()}</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Skeleton className="m-6 h-48" />
        )}
      </div>
    );
  const selectedSurfaceId =
    surfaceId ?? (owner.identityKind === "app-directory" ? "app" : "readme");
  const openFull = async () => {
    if (error || (await prepareActiveContentDeactivation()) === "blocked")
      return false;
    const intent = { kind: "target" as const, surfaceId: selectedSurfaceId };
    if (
      owner.identityKind === "collection-directory" ||
      owner.identityKind === "app-directory"
    ) {
      if (selectedSurfaceId === "collection") {
        fullRoute.onViewNameChange(viewName);
        if (calendarScope) fullRoute.onCalendarScopeChange(calendarScope);
      }
      openOwner(
        {
          kind:
            owner.identityKind === "collection-directory"
              ? "collection"
              : "app-directory",
          path: owner.ownerPath,
          spaceId: owner.spaceId,
        },
        { scopeOpenIntent: intent },
      );
    } else
      openPage(owner.readmePath, owner.spaceId, { scopeOpenIntent: intent });
    return true;
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end px-2 pb-2">
        {props.renderActions(openFull, owner)}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <Button onClick={retry}>{m.attachments_retry()}</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <ScopeSurfacePage
          owner={owner}
          presentation="compact"
          sessionKey={props.sessionKey}
          routeState={routeState}
          compactSurfaceState={{
            surfaceId: selectedSurfaceId,
            onSurfaceIdChange: setSurfaceId,
          }}
          fallbackTitle={props.fallbackTitle}
          fallbackIcon={props.fallbackIcon}
          metadataBefore={props.metadataBefore}
          headerActions={
            owner.identityKind === "page-file" ||
            owner.identityKind === "page-directory"
              ? null
              : undefined
          }
          renderHeaderActions={props.renderHeaderActions}
          registerNavigationGuard={props.registerNavigationGuard}
          onContentPathChange={(nextPath) => {
            setPathState({ input: props.path, current: nextPath });
            props.onContentPathChange?.(nextPath);
          }}
        />
      </div>
    </div>
  );
}
