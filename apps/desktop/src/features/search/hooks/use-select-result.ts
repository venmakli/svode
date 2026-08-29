import { useCallback } from "react";
import { toast } from "sonner";
import { getSpaceSnapshot, useSpace } from "@/features/space";
import { useOpenEntryDocument } from "@/features/entry/selection";
import { useCommandPaletteStore } from "../model";
import type { KnowledgeNodeKind } from "@/features/knowledge";
import * as m from "@/paraglide/messages.js";

// Click handler for a search result. Implements the §Q4 stale-result branch
// (status refetch from in-memory SpaceConfig) but only the v1 subset:
// ready → open, anything else → toast. The `missing` ghost-clone modal and
// `ready+missing-file` toast land with Phase 7 §Q8 (cross-space links).
export function useSelectResult({
  onBeforeNavigation,
  onAfterNavigation,
}: {
  onBeforeNavigation?: () => Promise<boolean>;
  onAfterNavigation?: () => void;
} = {}) {
  const spaces = useSpace((s) => s.spaces);
  const activeRootId = useSpace((s) => s.activeRootId);
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const openSpace = useSpace((s) => s.openSpace);
  const clearActiveSpace = useSpace((s) => s.clearActiveSpace);
  const openDocument = useOpenEntryDocument();
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  return useCallback(
    async (item: SearchNavigationTarget) => {
      const targetSpace =
        item.spaceId === null
          ? null
          : spaces.find((space) => space.id === item.spaceId);
      if (item.spaceId !== null) {
        if (!targetSpace || targetSpace.status !== "ready") {
          toast.error(m.search_space_unavailable({ name: item.spaceName }));
          return;
        }
      }

      if (onBeforeNavigation && !(await onBeforeNavigation())) {
        return;
      }

      if (item.spaceId === null) {
        clearActiveSpace();
      } else if (item.spaceId !== getSpaceSnapshot().activeSpaceId) {
        void openSpace(item.spaceId);
      }

      const targetSpaceId = item.spaceId === null ? activeRootId : item.spaceId;
      const targetSpacePath =
        item.spaceId === null ? activeRootPath : targetSpace?.path;
      if (!targetSpacePath) {
        toast.error(m.search_space_unavailable({ name: item.spaceName }));
        return;
      }
      openDocument(item.path, targetSpaceId ?? undefined, { reveal: true });
      setOpen(false);
      onAfterNavigation?.();
    },
    [
      spaces,
      activeRootId,
      activeRootPath,
      clearActiveSpace,
      onBeforeNavigation,
      onAfterNavigation,
      openSpace,
      openDocument,
      setOpen,
    ],
  );
}

export interface SearchNavigationTarget {
  spaceId: string | null;
  spaceName: string;
  path: string;
  kind?: KnowledgeNodeKind;
}
