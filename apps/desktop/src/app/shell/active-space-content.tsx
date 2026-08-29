import { FileText } from "lucide-react";
import { ArtifactSurface } from "@/features/artifact/app-shell";
import { useActiveContentSelection } from "@/features/artifact";
import type { TreeNode } from "@/features/space";
import { useSpace } from "@/features/space";
import { EmptyProjectState } from "@/features/space/app-shell";
import {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
  type ScopeOwnerKey,
} from "@/features/scope-surfaces";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCollectionRouteState } from "./hooks/use-collection-route-state";
import { ScopeSurfacePage } from "./scope-surface-page";
import * as m from "@/paraglide/messages.js";

function findNodeInTree(
  nodes: TreeNode[],
  targetPath: string,
): TreeNode | null {
  for (const node of nodes) {
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (node.path === targetPath || folderPath === targetPath) return node;
    const found = findNodeInTree(node.children, targetPath);
    if (found) return found;
  }
  return null;
}

export function ActiveSpaceContent() {
  const { selection, activePathRetarget } = useActiveContentSelection();
  const collectionRouteState = useCollectionRouteState();
  const { fileTrees, rootSpaces, spaces, activeRootId, activeRootPath } =
    useSpace();
  const artifactRequest =
    selection?.kind === "artifact" ? selection.request : null;
  const scopeOwnerRequest =
    selection?.kind === "scope-owner" ? selection.request : null;
  const selectionSpaceId =
    artifactRequest?.intent.target.spaceId ??
    scopeOwnerRequest?.owner.spaceId ??
    activeRootId;
  const selectedPath =
    artifactRequest?.intent.target.path ??
    (scopeOwnerRequest?.owner.kind === "collection"
      ? scopeOwnerRequest.owner.path
      : null);
  const tree = selectionSpaceId ? (fileTrees[selectionSpaceId] ?? []) : [];
  const activeNode = selectedPath ? findNodeInTree(tree, selectedPath) : null;
  const previousActiveNode =
    !activeNode &&
    activePathRetarget?.path === selectedPath &&
    activePathRetarget.spaceId === selectionSpaceId
      ? findNodeInTree(tree, activePathRetarget.fromPath)
      : null;
  const activeNodeSnapshot = activeNode ?? previousActiveNode;
  const activeSpace = selectionSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === selectionSpaceId)
    : null;
  const selectedScopeHome =
    scopeOwnerRequest?.owner.kind === "space"
      ? [...rootSpaces, ...spaces].find(
          (space) => space.id === scopeOwnerRequest.owner.spaceId,
        )
      : null;
  const hasChildren = spaces.length > 0;
  const rootTree = activeRootId ? (fileTrees[activeRootId] ?? []) : [];
  const hasDocuments = rootTree.length > 0;
  const isEmpty = !hasChildren && !hasDocuments;
  const isCollectionOwner = Boolean(
    selectedPath &&
    activeSpace &&
    selectionSpaceId &&
    (scopeOwnerRequest?.owner.kind === "collection" ||
      activeNodeSnapshot?.has_schema),
  );
  const collectionSessionKey =
    scopeOwnerRequest?.key ?? selectedPath ?? "collection";
  const previousCollectionOwnerKey =
    activePathRetarget &&
    activePathRetarget.path === selectedPath &&
    activePathRetarget.spaceId === selectionSpaceId &&
    selectionSpaceId
      ? (`collection:${selectionSpaceId}:${collectionOwnerPath(activePathRetarget.fromPath)}` as ScopeOwnerKey)
      : undefined;

  const activeContent =
    isCollectionOwner &&
    activeSpace &&
    selectionSpaceId &&
    activeRootPath &&
    selectedPath ? (
      <ScopeSurfacePage
        key={`collection-session:${selectionSpaceId}:${collectionSessionKey}`}
        owner={createCollectionDirectoryOwner({
          spaceId: selectionSpaceId,
          spacePath: activeSpace.path,
          projectPath: activeRootPath,
          ownerPath: collectionOwnerPath(selectedPath),
          status: activeSpace.status,
          hasSchema: true,
        })}
        presentation="full"
        routeState={collectionRouteState}
        openIntent={scopeOwnerRequest?.intent}
        openRequestKey={scopeOwnerRequest?.key}
        previousOwnerKey={previousCollectionOwnerKey}
        sessionKey={collectionSessionKey}
      />
    ) : artifactRequest && activeSpace && selectionSpaceId ? (
      <ArtifactSurface
        request={artifactRequest}
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        spaceId={selectionSpaceId}
      />
    ) : (
      <div className="h-full" />
    );

  if (scopeOwnerRequest?.owner.kind === "space" || !selection || isEmpty) {
    if (selectedScopeHome?.status === "ready" && activeRootPath) {
      const owner = createRegisteredSpaceOwner({
        spaceId: selectedScopeHome.id,
        spacePath: selectedScopeHome.path,
        projectPath: activeRootPath,
        status: selectedScopeHome.status,
        hasSchema: selectedScopeHome.hasSchema,
      });
      return (
        <div className="flex h-full flex-col overflow-hidden">
          <div className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <ScopeSurfacePage
              key={owner.ownerKey}
              owner={owner}
              presentation="full"
              routeState={collectionRouteState}
              fallbackTitle={selectedScopeHome.name}
              fallbackIcon={selectedScopeHome.icon || null}
              openIntent={scopeOwnerRequest?.intent}
              openRequestKey={scopeOwnerRequest?.key}
            />
          </div>
        </div>
      );
    }
    if (selectedScopeHome) {
      return (
        <ScopeHomeFallback
          name={selectedScopeHome.name}
          icon={selectedScopeHome.icon}
        />
      );
    }
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <EmptyProjectState />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {activeContent}
      </div>
    </div>
  );
}

function collectionOwnerPath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/readme\.md$/i, "");
}

function ScopeHomeFallback({ name, icon }: { name: string; icon: string }) {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {icon ? <span>{icon}</span> : <FileText />}
        </EmptyMedia>
        <EmptyTitle>{m.scope_home_empty_title({ name })}</EmptyTitle>
        <EmptyDescription>{m.scope_home_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
