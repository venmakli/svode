import { useCallback } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { SpaceInfo } from "../model";

interface UseSpaceSidebarOrderInput {
  reorderSpaces: (orderedSpaceIds: string[]) => Promise<void>;
  spaces: SpaceInfo[];
}

export function useSpaceSidebarOrder({
  reorderSpaces,
  spaces,
}: UseSpaceSidebarOrderInput) {
  return useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = spaces.findIndex((space) => space.id === active.id);
      const newIndex = spaces.findIndex((space) => space.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const nextSpaces = arrayMove(spaces, oldIndex, newIndex);
      try {
        await reorderSpaces(nextSpaces.map((space) => space.id));
      } catch (err) {
        console.error("Failed to reorder spaces:", err);
        toast.error(m.toast_error());
      }
    },
    [reorderSpaces, spaces],
  );
}
