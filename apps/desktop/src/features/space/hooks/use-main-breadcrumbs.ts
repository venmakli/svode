import { useCallback } from "react";
import {
  useActiveContentPath,
  useActiveContentSpaceId,
  useOpenScopeOwner,
} from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import {
  breadcrumbSpaceChoices,
  buildBreadcrumbPrefix,
  buildMainBreadcrumbs,
  type BreadcrumbProject,
  type MainBreadcrumbTarget,
} from "../lib/space-breadcrumbs";
import { useSpaceStore, type SpaceState } from "../model";

export interface BreadcrumbNavigationProps {
  /** The navigation guards every breadcrumb passes before it opens. */
  onBeforeNavigation?: () => Promise<boolean>;
  /** Shows the content surface when the breadcrumbs live on another one. */
  onActivateContent?: () => void;
}

function breadcrumbProject(state: SpaceState): BreadcrumbProject | null {
  return state.activeRootId
    ? {
        id: state.activeRootId,
        name: state.activeRootName ?? "",
        icon: state.activeRootIcon,
      }
    : null;
}

/** The breadcrumbs of the object the main area shows. */
export function useMainBreadcrumbs(home: boolean) {
  const path = useActiveContentPath();
  const contentSpaceId = useActiveContentSpaceId();
  const state = useSpaceStore();
  const project = breadcrumbProject(state);
  const treeId = contentSpaceId ?? state.activeRootId;
  const space =
    contentSpaceId && contentSpaceId !== state.activeRootId
      ? (state.spaces.find((candidate) => candidate.id === contentSpaceId) ??
        null)
      : null;

  return {
    ...buildMainBreadcrumbs({
      home,
      project,
      space,
      path,
      tree: treeId ? (state.fileTrees[treeId] ?? []) : [],
    }),
    spaceChoices: breadcrumbSpaceChoices(state.spaces),
  };
}

/** The project and Space before an object of the Space at `spacePath`. */
export function useSpaceBreadcrumbPrefix(home: boolean, spacePath: string) {
  const state = useSpaceStore();
  const space =
    spacePath === state.activeRootPath
      ? null
      : (state.spaces.find((candidate) => candidate.path === spacePath) ??
        null);
  return {
    crumbs: buildBreadcrumbPrefix({
      home,
      project: breadcrumbProject(state),
      space,
    }),
    spaceChoices: breadcrumbSpaceChoices(state.spaces),
  };
}

/** Opens what a breadcrumb points to after the navigation guards. */
export function useBreadcrumbNavigation({
  onBeforeNavigation,
  onActivateContent,
}: BreadcrumbNavigationProps) {
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();

  return useCallback(
    async (target: MainBreadcrumbTarget) => {
      if (onBeforeNavigation && !(await onBeforeNavigation())) return;
      const { activeRootId, activeSpaceId, clearActiveSpace, openSpace } =
        useSpaceStore.getState();
      onActivateContent?.();
      if (target.kind === "project-home") {
        if (!activeRootId) return;
        if (activeSpaceId) clearActiveSpace();
        openScopeOwner({ kind: "space", spaceId: activeRootId });
      } else if (target.kind === "space-home") {
        openScopeOwner({ kind: "space", spaceId: target.spaceId });
        void openSpace(target.spaceId);
      } else if (target.segment.ownerKind) {
        openScopeOwner({
          kind: target.segment.ownerKind,
          path: target.segment.path,
          spaceId: target.spaceId,
        });
      } else {
        openPage(target.segment.path, target.spaceId ?? undefined);
      }
    },
    [onActivateContent, onBeforeNavigation, openPage, openScopeOwner],
  );
}
