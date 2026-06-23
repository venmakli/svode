import { useEntrySelectionStore } from "@/features/entry/selection";
import { buildSpaceBreadcrumbSegments } from "../lib/space-breadcrumbs";
import { useSpaceStore } from "../model";

export function useMainBreadcrumbs() {
  const { activeDocument, activeDocumentSpaceId, openDocument } =
    useEntrySelectionStore();
  const { activeRootId, fileTrees, openSpace, spaces } = useSpaceStore();

  if (!activeDocument) {
    const selectedSpace =
      activeDocumentSpaceId && activeDocumentSpaceId !== activeRootId
        ? spaces.find((space) => space.id === activeDocumentSpaceId)
        : null;

    return {
      activeDocument,
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
    openDocument,
    openSpace,
    selectedSpace: null,
    segments: buildSpaceBreadcrumbSegments(activeDocument, tree),
    treeId,
    workspaceName,
    workspaces: spaces,
  };
}
