import { useMemo, useState } from "react";
import { Database, FileText, PanelsTopLeft } from "lucide-react";
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
  ScopeOwnerFactsError,
  ScopeSurfaceErrorBoundary,
  useScopeOwner,
  type ScopeOwnerRef,
  type ScopePeekContext,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import { UserEditScope } from "@/features/navigation";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";
import { useCollectionRouteState } from "./hooks/use-collection-route-state";
import {
  ScopeSurfacePage,
  type ScopeOwnerIdentity,
} from "./scope-surface-page";

export function CompactScopePeek(props: ScopePeekContext) {
  const [pathState, setPathState] = useState({
    input: props.path,
    current: props.path,
  });
  if (pathState.input !== props.path)
    setPathState({ input: props.path, current: props.path });
  const path = pathState.input === props.path ? pathState.current : props.path;
  const { owner, error, retry } = useScopeOwner({
    target: {
      spaceId: props.spaceId,
      spacePath: props.spacePath,
      projectPath: props.projectPath,
      path,
    },
    // One Peek session keeps its owner while a new path of it resolves.
    retainPrevious: true,
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
  const [identity, setIdentity] = useState<ScopeOwnerIdentity | null>(null);
  if (owner && surfaceId === null)
    setSurfaceId(owner.identityKind === "app-directory" ? "app" : "readme");
  const selectedSurfaceId =
    surfaceId ?? (owner?.identityKind === "app-directory" ? "app" : "readme");
  const openFull = async () => {
    if (
      !owner ||
      error ||
      (await prepareActiveContentDeactivation()) === "blocked"
    )
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
  const identityIcon = identity?.icon ?? props.fallbackIcon;
  const topBar = (
    <PeekTopBar
      identity={
        <PeekIdentity
          icon={
            identityIcon?.trim() ? (
              identityIcon
            ) : (
              <ScopeOwnerFallbackIcon owner={owner} />
            )
          }
          name={identity?.title ?? props.fallbackTitle ?? path}
        />
      }
      changes={owner ? props.renderChanges?.(owner) : null}
      onExpand={() => props.onExpand(openFull)}
      expandDisabled={!owner}
      onClose={props.onClose}
    />
  );
  if (!owner)
    return (
      <div className="flex min-h-full flex-col">
        {topBar}
        {error ? (
          <ScopeOwnerFactsError error={error} onRetry={retry} />
        ) : (
          <Skeleton className="m-6 h-48" />
        )}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {topBar}
      {error ? <ScopeOwnerFactsError error={error} onRetry={retry} /> : null}
      <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Edits inside a peek never keep an object in Now. */}
        <UserEditScope mainArea={false}>
          <ScopeSurfaceErrorBoundary>
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
              // Pages have no header actions here; Collections and Apps keep
              // their owner menu.
              headerActions={
                owner.identityKind === "page-file" ||
                owner.identityKind === "page-directory"
                  ? null
                  : undefined
              }
              renderHeaderActions={props.renderHeaderActions}
              registerNavigationGuard={props.registerNavigationGuard}
              onPageGone={props.dismiss}
              onIdentityChange={setIdentity}
              onContentPathChange={(nextPath) => {
                setPathState({ input: props.path, current: nextPath });
                props.onContentPathChange?.(nextPath);
              }}
            />
          </ScopeSurfaceErrorBoundary>
        </UserEditScope>
      </div>
    </div>
  );
}

function ScopeOwnerFallbackIcon({ owner }: { owner: ScopeOwnerRef | null }) {
  if (owner?.identityKind === "collection-directory") return <Database />;
  if (owner?.identityKind === "app-directory") return <PanelsTopLeft />;
  return <FileText />;
}
