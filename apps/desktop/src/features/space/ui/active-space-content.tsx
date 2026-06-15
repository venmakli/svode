import { useEffect } from "react";
import { unwatchSpace, watchSpace } from "@/platform/space/space-api";
import { useEntrySelectionStore } from "@/features/entry";
import { selectActiveSpacePath, useSpaceStore } from "../model";
import { CollectionScreen, EntryDocumentScreen } from "@/features/collection";
import type { TreeNode } from "@/features/entry";
import { EmptyProjectState } from "./empty-project-state";

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
  const { activeDocument, activeDocumentSpaceId } = useEntrySelectionStore();
  const {
    fileTrees,
    rootSpaces,
    spaces,
    activeRootId,
    activeRootPath,
  } = useSpaceStore();
  const watchSpacePath = useSpaceStore(selectActiveSpacePath);
  const documentSpaceId = activeDocumentSpaceId ?? activeRootId;
  const tree = documentSpaceId ? (fileTrees[documentSpaceId] ?? []) : [];
  const activeNode = activeDocument
    ? findNodeInTree(tree, activeDocument)
    : null;
  const activeSpace = documentSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === documentSpaceId)
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
    activeDocument ? (
      <CollectionScreen
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        documentPath={activeDocument}
        spaceId={documentSpaceId}
        hasReadme={activeNode.path.toLowerCase().endsWith(".md")}
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

  useEffect(() => {
    if (!watchSpacePath) return;
    watchSpace(watchSpacePath).catch((error) =>
      console.error("Failed to watch space:", error),
    );
    return () => {
      unwatchSpace(watchSpacePath).catch((error) =>
        console.error("Failed to unwatch space:", error),
      );
    };
  }, [watchSpacePath]);

  if (!activeDocument || isEmpty) {
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
