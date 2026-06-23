import { useEntrySelectionStore } from "@/features/entry/selection";
import type { TreeNode } from "@/features/entry";
import { CollectionScreen, EntryDocumentScreen } from "@/features/collection/ui";
import { useSpace } from "@/features/space";
import { EmptyProjectState } from "@/features/space/app-shell";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FileText } from "lucide-react";
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
  const { activeDocument, activeDocumentSpaceId } = useEntrySelectionStore();
  const {
    fileTrees,
    rootSpaces,
    spaces,
    activeRootId,
    activeRootPath,
  } = useSpace();
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

  if (!activeDocument || isEmpty) {
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
