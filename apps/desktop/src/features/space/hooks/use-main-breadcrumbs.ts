import {
  useActiveEntrySelection,
  useOpenEntryDocument,
} from "@/features/entry/selection";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  buildSpaceBreadcrumbSegments,
  type SpaceBreadcrumbSegment,
} from "../lib/space-breadcrumbs";
import { useSpaceStore } from "../model";

export function useMainBreadcrumbs() {
  const { activeDocument, activeDocumentSpaceId } = useActiveEntrySelection();
  const openDocument = useOpenEntryDocument();
  const openScopeOwner = useOpenScopeOwner();
  const { activeRootId, fileTrees, openSpace, spaces } = useSpaceStore();
  const openBreadcrumb = (
    segment: SpaceBreadcrumbSegment,
    targetSpaceId?: string,
  ) => {
    if (segment.ownerKind === "collection") {
      openScopeOwner({
        kind: "collection",
        path: segment.path,
        spaceId: targetSpaceId ?? null,
      });
    } else {
      openDocument(segment.path, targetSpaceId);
    }
  };

  if (!activeDocument) {
    const selectedSpace =
      activeDocumentSpaceId && activeDocumentSpaceId !== activeRootId
        ? spaces.find((space) => space.id === activeDocumentSpaceId)
        : null;

    return {
      activeDocument,
      openBreadcrumb,
      openDocument,
      openSpace,
      selectedSpace,
      segments: [],
      treeId: activeDocumentSpaceId,
      workspaceName: "",
      workspaces: spaces,
    };
  }

  const activeWorkspace = activeDocumentSpaceId
    ? spaces.find((space) => space.id === activeDocumentSpaceId)
    : null;
  const showWorkspaceName = activeDocumentSpaceId !== activeRootId;
  const workspaceName =
    activeWorkspace && showWorkspaceName
      ? `${activeWorkspace.icon} ${activeWorkspace.name}`
      : "";

  const treeId = activeDocumentSpaceId;
  const tree = treeId ? (fileTrees[treeId] ?? []) : [];

  return {
    activeDocument,
    openBreadcrumb,
    openDocument,
    openSpace,
    selectedSpace: null,
    segments: buildSpaceBreadcrumbSegments(activeDocument, tree),
    treeId,
    workspaceName,
    workspaces: spaces,
  };
}
