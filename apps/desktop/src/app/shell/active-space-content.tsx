import { useActiveEntrySelection } from "@/features/entry/selection";
import type { TreeNode } from "@/features/space";
import { EntryDocumentScreen } from "@/features/entry/app-shell";
import { useSpace } from "@/features/space";
import { EmptyProjectState } from "@/features/space/app-shell";
import {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "@/features/scope-surfaces";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FileText } from "lucide-react";
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
  const { activeDocument, activeDocumentSpaceId, activeScopeOpenRequest } =
    useActiveEntrySelection();
  const collectionRouteState = useCollectionRouteState();
  const { fileTrees, rootSpaces, spaces, activeRootId, activeRootPath } =
    useSpace();
  const documentSpaceId = activeDocumentSpaceId ?? activeRootId;
  const tree = documentSpaceId ? (fileTrees[documentSpaceId] ?? []) : [];
  const activeNode = activeDocument
    ? findNodeInTree(tree, activeDocument)
    : null;
  const activeSpace = documentSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === documentSpaceId)
    : null;
  const selectedScopeHome =
    !activeDocument && activeDocumentSpaceId
      ? [...rootSpaces, ...spaces].find(
          (space) => space.id === activeDocumentSpaceId,
        )
      : null;
  const hasChildren = spaces.length > 0;
  const rootTree = activeRootId ? (fileTrees[activeRootId] ?? []) : [];
  const hasDocuments = rootTree.length > 0;
  const isEmpty = !hasChildren && !hasDocuments;
  const isCollection = Boolean(
    activeNode?.has_schema && activeSpace && documentSpaceId,
  );
  const usesEntryDocumentScreen = Boolean(
    !isCollection && activeSpace && documentSpaceId && activeDocument,
  );
  const activeContent =
    isCollection &&
    activeNode &&
    activeSpace &&
    documentSpaceId &&
    activeRootPath &&
    activeDocument ? (
      <ScopeSurfacePage
        key={`collection:${documentSpaceId}:${collectionOwnerPath(activeDocument)}`}
        owner={createCollectionDirectoryOwner({
          spaceId: documentSpaceId,
          spacePath: activeSpace.path,
          projectPath: activeRootPath,
          ownerPath: collectionOwnerPath(activeDocument),
          status: activeSpace.status,
          hasSchema: true,
        })}
        presentation="full"
        routeState={collectionRouteState}
        openIntent={activeScopeOpenRequest?.intent}
        openRequestKey={activeScopeOpenRequest?.key}
      />
    ) : activeSpace && documentSpaceId && activeDocument ? (
      <EntryDocumentScreen
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        documentPath={activeDocument}
        spaceId={documentSpaceId}
      />
    ) : (
      <div className="h-full" />
    );

  if (!activeDocument || isEmpty) {
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
              openIntent={activeScopeOpenRequest?.intent}
              openRequestKey={activeScopeOpenRequest?.key}
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
        <div className="flex-1 min-h-0 overflow-hidden">
          <EmptyProjectState />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className={
          isCollection || usesEntryDocumentScreen
            ? "scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
            : "min-h-0 min-w-0 flex-1 overflow-hidden"
        }
      >
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
