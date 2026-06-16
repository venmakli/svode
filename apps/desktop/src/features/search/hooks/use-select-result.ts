import { useCallback } from "react";
import { toast } from "sonner";
import { useSpaceStore } from "@/features/space";
import { useEntrySelectionStore } from "@/features/entry";
import { useCommandPaletteStore } from "../model";
import { joinAbs } from "../lib/utils";
import type { SearchItem } from "../model";
import * as m from "@/paraglide/messages.js";

// Click handler for a search result. Implements the §Q4 stale-result branch
// (status refetch from in-memory SpaceConfig) but only the v1 subset:
// ready → open, anything else → toast. The `missing` ghost-clone modal and
// `ready+missing-file` toast land with Phase 7 §Q8 (cross-space links).
export function useSelectResult() {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const openSpace = useSpaceStore((s) => s.openSpace);
  const clearActiveSpace = useSpaceStore((s) => s.clearActiveSpace);
  const openDocument = useEntrySelectionStore((s) => s.openDocument);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  return useCallback(
    (item: SearchItem) => {
      if (item.spaceId !== null) {
        const target = spaces.find((s) => s.id === item.spaceId);
        if (!target || target.status !== "ready") {
          toast.error(m.search_space_unavailable({ name: item.spaceName }));
          return;
        }
      }

      if (item.spaceId === null) {
        clearActiveSpace();
      } else if (item.spaceId !== useSpaceStore.getState().activeSpaceId) {
        void openSpace(item.spaceId);
      }

      const targetSpaceId =
        item.spaceId === null ? activeRootId : item.spaceId;
      openDocument(joinAbs(item.spacePath, item.path), targetSpaceId ?? undefined);
      setOpen(false);
    },
    [spaces, activeRootId, clearActiveSpace, openSpace, openDocument, setOpen],
  );
}
