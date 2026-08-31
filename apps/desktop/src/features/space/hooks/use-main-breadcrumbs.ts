import {
  useActiveContentPath,
  useActiveContentSpaceId,
  useOpenScopeOwner,
} from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import {
  buildSpaceBreadcrumbSegments,
  type SpaceBreadcrumbSegment,
} from "../lib/space-breadcrumbs";
import { useSpaceStore } from "../model";

export function useMainBreadcrumbs() {
  const activeContentPath = useActiveContentPath();
  const activeContentSpaceId = useActiveContentSpaceId();
  const openPage = useOpenPage();
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
      openPage(segment.path, targetSpaceId);
    }
  };

  if (!activeContentPath) {
    const selectedSpace =
      activeContentSpaceId && activeContentSpaceId !== activeRootId
        ? spaces.find((space) => space.id === activeContentSpaceId)
        : null;

    return {
      activeContentPath,
      openBreadcrumb,
      openPage,
      openSpace,
      selectedSpace,
      segments: [],
      treeId: activeContentSpaceId,
      workspaceName: "",
      workspaces: spaces,
    };
  }

  const activeWorkspace = activeContentSpaceId
    ? spaces.find((space) => space.id === activeContentSpaceId)
    : null;
  const showWorkspaceName = activeContentSpaceId !== activeRootId;
  const workspaceName =
    activeWorkspace && showWorkspaceName
      ? `${activeWorkspace.icon} ${activeWorkspace.name}`
      : "";

  const treeId = activeContentSpaceId;
  const tree = treeId ? (fileTrees[treeId] ?? []) : [];

  return {
    activeContentPath,
    openBreadcrumb,
    openPage,
    openSpace,
    selectedSpace: null,
    segments: buildSpaceBreadcrumbSegments(activeContentPath, tree),
    treeId,
    workspaceName,
    workspaces: spaces,
  };
}
