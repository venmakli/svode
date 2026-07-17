import { useCallback, useMemo, type ReactNode } from "react";
import {
  CollectionViewsSurface,
  type CollectionViewsSurfaceProps,
} from "@/features/collection/scope-surface";
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
}

export function ScopeSurfacePage({
  owner,
  presentation,
  routeState,
  headerActions,
}: ScopeSurfacePageProps) {
  const openDocument = useOpenEntryDocument();
  const openPath = useCallback(
    (path: string, spaceId?: string | null) =>
      openDocument(path, spaceId ?? owner.spaceId),
    [openDocument, owner.spaceId],
  );
  const renderNested = useCallback(
    (entry: Entry, actions: ReactNode) => {
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
            routeState={routeState}
            renderNested={renderNested}
          />
        ),
      }),
    [owner, renderNested, routeState],
  );
  const initialSurfaceId =
    presentation === "compact" || owner.identityKind === "registered-space"
      ? "readme"
      : "collection";

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
          <ScopeOwnerHeader
            actions={headerActions ?? <ScopeOwnerActions />}
          />
        }
        initialSurfaceId={initialSurfaceId}
      />
    </EntryDetailProvider>
  );
}

function collectionOwnerPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/\/readme\.md$/i, "");
}
