import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  CollectionViewsSurface,
  type CollectionViewsSurfaceProps,
} from "@/features/collection/scope-surface";
import type {
  CalendarScope,
  CollectionPeekSurfaceState,
  CollectionRouteState,
} from "@/features/collection/app-shell";
import {
  EntryDetailProvider,
  ReadmeSurface,
  ScopeOwnerActions,
  ScopeOwnerHeader,
} from "@/features/entry/scope-surface";
import { useOpenEntryDocument } from "@/features/entry/selection";
import {
  createCollectionDirectoryOwner,
  ScopeSurfaceHost,
  type ScopeOpenIntent,
  type ScopeOwnerRef,
  type ScopePresentation,
} from "@/features/scope-surfaces";
import type { Entry } from "@/features/entry";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";

interface ScopeSurfacePageProps {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
  routeState?: CollectionViewsSurfaceProps["routeState"];
  headerActions?: ReactNode;
  openIntent?: ScopeOpenIntent;
  openRequestKey?: number;
  compactSurfaceState?: CollectionPeekSurfaceState;
}

export function ScopeSurfacePage({
  owner,
  presentation,
  routeState,
  headerActions,
  openIntent,
  openRequestKey,
  compactSurfaceState,
}: ScopeSurfacePageProps) {
  const [compactViewName, setCompactViewName] = useState<string | null>(null);
  const [compactCalendarScope, setCompactCalendarScope] =
    useState<CalendarScope | null>(null);
  const [localCompactSurfaceId, setLocalCompactSurfaceId] =
    useState<CollectionPeekSurfaceState["surfaceId"]>("readme");
  const compactRouteState = useMemo<CollectionRouteState>(
    () => ({
      viewName: compactViewName,
      onViewNameChange: setCompactViewName,
      calendarScope: compactCalendarScope,
      onCalendarScopeChange: setCompactCalendarScope,
    }),
    [compactCalendarScope, compactViewName],
  );
  const collectionRouteState =
    presentation === "compact" ? (routeState ?? compactRouteState) : routeState;
  const openDocument = useOpenEntryDocument();
  const openPath = useCallback(
    (path: string, spaceId?: string | null) =>
      openDocument(path, spaceId ?? owner.spaceId),
    [openDocument, owner.spaceId],
  );
  const renderNested = useCallback(
    (
      entry: Entry,
      actions: ReactNode,
      nestedRouteState: CollectionRouteState,
      nestedSurfaceState: CollectionPeekSurfaceState,
    ) => {
      const nestedOwner = createCollectionDirectoryOwner({
        spaceId: owner.spaceId,
        spacePath: owner.spacePath,
        projectPath: owner.projectPath,
        ownerPath: collectionOwnerPath(entry.path),
        status: "ready",
        hasSchema: true,
      });
      return (
        <ScopeSurfacePage
          key={nestedOwner.ownerKey}
          owner={nestedOwner}
          presentation="compact"
          routeState={nestedRouteState}
          compactSurfaceState={nestedSurfaceState}
          headerActions={actions}
        />
      );
    },
    [owner.projectPath, owner.spaceId, owner.spacePath],
  );
  const contributions = useMemo(
    () =>
      createScopeSurfaceContributions({
        readme: () => <ReadmeSurface />,
        collection: () => (
          <CollectionViewsSurface
            spacePath={owner.spacePath}
            projectPath={owner.projectPath}
            documentPath={owner.readmePath}
            spaceId={owner.spaceId}
            routeState={collectionRouteState}
            renderNested={renderNested}
          />
        ),
      }),
    [collectionRouteState, owner, renderNested],
  );
  return (
    <EntryDetailProvider
      spacePath={owner.spacePath}
      projectPath={owner.projectPath}
      spaceId={owner.spaceId}
      readmePath={owner.readmePath}
      ownerPath={owner.ownerPath}
      onOpenPath={openPath}
    >
      <ScopeSurfaceHost
        owner={owner}
        presentation={presentation}
        contributions={contributions}
        header={
          <ScopeOwnerHeader actions={headerActions ?? <ScopeOwnerActions />} />
        }
        openIntent={openIntent}
        openRequestKey={openRequestKey}
        compactSurfaceId={
          compactSurfaceState?.surfaceId ?? localCompactSurfaceId
        }
        onCompactSurfaceIdChange={
          compactSurfaceState?.onSurfaceIdChange ?? setLocalCompactSurfaceId
        }
      />
    </EntryDetailProvider>
  );
}

function collectionOwnerPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/\/readme\.md$/i, "");
}
