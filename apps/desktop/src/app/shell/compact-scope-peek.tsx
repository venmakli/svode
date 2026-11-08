import { useEffect, useMemo, useState } from "react";
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
  createRegisteredSpaceOwner,
  ScopeOwnerFactsError,
  ScopeSurfaceErrorBoundary,
  resolveDefaultScopeSurface,
  type ScopeOwnerRef,
  type ScopePeekContext,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import { UserEditScope } from "@/features/navigation";
import { useSpace } from "@/features/space";
import { ChangesControl, type ChangesTarget } from "@/features/changes";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";
import { useCollectionRouteState } from "./hooks/use-collection-route-state";
import { useSpaceScopeOwner } from "./hooks/use-space-scope-owner";
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
  // The Space itself is its registered owner, as its home in main; content
  // resolves its owner by its path.
  const spaceRoot = path === ".";
  const space = useSpace((state) =>
    spaceRoot
      ? [...state.rootSpaces, ...state.spaces].find(
          (candidate) => candidate.id === props.spaceId,
        )
      : undefined,
  );
  const resolved = useSpaceScopeOwner({
    target: spaceRoot
      ? null
      : {
          spaceId: props.spaceId,
          spacePath: props.spacePath,
          projectPath: props.projectPath,
          path,
        },
    // One Peek session keeps its owner while a new path of it resolves.
    retainPrevious: true,
  });
  const spaceOwner = useMemo(
    () =>
      space?.status === "ready"
        ? createRegisteredSpaceOwner({
            spaceId: space.id,
            spacePath: space.path,
            projectPath: props.projectPath,
            status: space.status,
            hasSchema: space.hasSchema,
            hasApp: space.hasApp,
          })
        : null,
    [props.projectPath, space],
  );
  const { owner, error, gone, retry } = spaceRoot
    ? { ...resolved, owner: spaceOwner, error: null, gone: !spaceOwner }
    : resolved;
  // A Collection, App or Space whose folder is gone closes its Peek; a Page
  // closes it itself, and a Collection that lost only its README stays.
  const folderOwnerGone =
    spaceRoot ||
    owner?.identityKind === "collection-directory" ||
    owner?.identityKind === "app-directory"
      ? gone
      : false;
  const { dismiss } = props;
  useEffect(() => {
    if (folderOwnerGone) dismiss();
  }, [dismiss, folderOwnerGone]);
  const fallbackTitle = spaceRoot ? space?.name : props.fallbackTitle;
  const fallbackIcon = spaceRoot ? space?.icon || null : props.fallbackIcon;
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
  const defaultSurfaceId: ScopeSurfaceId =
    props.surfaceId ??
    (owner ? resolveDefaultScopeSurface(owner, "compact") : "readme");
  if (owner && surfaceId === null) setSurfaceId(defaultSurfaceId);
  const selectedSurfaceId = surfaceId ?? defaultSurfaceId;
  const openFull = async () => {
    if (
      !owner ||
      error ||
      (await prepareActiveContentDeactivation()) === "blocked"
    )
      return false;
    const intent = { kind: "target" as const, surfaceId: selectedSurfaceId };
    if (owner.identityKind === "registered-space") {
      openOwner(
        { kind: "space", spaceId: owner.spaceId },
        { scopeOpenIntent: intent },
      );
      return true;
    }
    if (
      owner.identityKind === "collection-directory" ||
      owner.identityKind === "app-directory"
    ) {
      if (selectedSurfaceId === "pages") {
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
  const identityIcon = identity?.icon ?? fallbackIcon;
  const identityName = identity?.title ?? fallbackTitle ?? path;
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
          name={identityName}
        />
      }
      changes={
        owner ? (
          <ChangesControl
            origin="peek"
            target={ownerChangesTarget(owner, identityName)}
          />
        ) : null
      }
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
              fallbackTitle={fallbackTitle}
              fallbackIcon={fallbackIcon}
              metadataBefore={props.metadataBefore}
              // Pages and the Space have no header actions here; Collections
              // and Apps keep their owner menu.
              headerActions={
                owner.identityKind === "page-file" ||
                owner.identityKind === "page-directory" ||
                owner.identityKind === "registered-space"
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

// The scope main shows for the same owner: a Page its file or folder, a
// Collection or App its directory.
function ownerChangesTarget(owner: ScopeOwnerRef, name: string): ChangesTarget {
  if (owner.identityKind === "registered-space")
    return {
      kind: owner.spacePath === owner.projectPath ? "project" : "space",
      sourceShape: "directory",
      spacePath: owner.spacePath,
      projectPath: owner.projectPath,
      path: owner.readmePath,
      name,
    };
  const page =
    owner.identityKind === "page-file" ||
    owner.identityKind === "page-directory";
  return {
    kind: page ? "page" : "owner",
    sourceShape: owner.identityKind === "page-file" ? "file" : "directory",
    spacePath: owner.spacePath,
    projectPath: owner.projectPath,
    path: owner.readmePath,
    name,
  };
}

function ScopeOwnerFallbackIcon({ owner }: { owner: ScopeOwnerRef | null }) {
  if (owner?.identityKind === "collection-directory") return <Database />;
  if (
    owner?.identityKind === "app-directory" ||
    owner?.identityKind === "registered-space"
  )
    return <PanelsTopLeft />;
  return <FileText />;
}
