import { useCallback } from "react";
import type { Page } from "@/features/page";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { saveCollectionTreeOrder } from "../api";

export function useCollectionTreeOrder({
  spacePath,
  projectPath,
}: {
  spacePath: string;
  projectPath?: string | null;
}) {
  const sidebarSpaceId = useSpace((state) => {
    const space =
      state.spaces.find((item) => item.path === spacePath) ??
      state.rootSpaces.find((item) => item.path === spacePath);
    return space?.id ?? null;
  });
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);

  const reloadOrderParent = useCallback(
    async (parentPath: string) => {
      if (sidebarSpaceId) {
        await reloadTreeParent(sidebarSpaceId, parentPath);
      }
    },
    [reloadTreeParent, sidebarSpaceId],
  );

  const saveOrder = useCallback(
    async (orderKey: string, entries: Page[]) => {
      await saveCollectionTreeOrder({
        spacePath,
        orderKey,
        entries,
        projectPath,
      });
    },
    [projectPath, spacePath],
  );

  return { reloadOrderParent, saveOrder };
}
