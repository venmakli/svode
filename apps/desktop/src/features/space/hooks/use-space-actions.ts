import { useCallback } from "react";
import * as spaceNotifications from "../effects/space-notifications";
import {
  openScopeHomeSelection,
  openSpaceReadmeDocument,
} from "../effects/space-selection";
import { useSpaceStore } from "../model";
import type { SpaceGitType, SpaceInfo } from "../model";

export function useSpaceActions() {
  const openRootAction = useSpaceStore((state) => state.openRoot);
  const openRootWindowAction = useSpaceStore((state) => state.openRootWindow);
  const openLastActiveRootAction = useSpaceStore(
    (state) => state.openLastActiveRoot,
  );
  const getWindowOpenIntentAction = useSpaceStore(
    (state) => state.getWindowOpenIntent,
  );
  const createRootAction = useSpaceStore((state) => state.createRoot);
  const deleteRootAction = useSpaceStore((state) => state.deleteRoot);
  const createSpaceAction = useSpaceStore((state) => state.createSpace);
  const deleteSpaceAction = useSpaceStore((state) => state.deleteSpace);
  const createEntryAction = useSpaceStore((state) => state.createEntry);

  const selectRootHome = useCallback((rootId: string) => {
    openScopeHomeSelection(
      rootId,
      useSpaceStore.getState().fileTrees[rootId] ?? [],
    );
  }, []);

  const openRoot = useCallback(
    async (id: string): Promise<boolean> => {
      const opened = await openRootAction(id);
      if (opened) {
        selectRootHome(id);
      } else {
        spaceNotifications.notifySpaceError();
      }
      return opened;
    },
    [openRootAction, selectRootHome],
  );

  const openLastActiveRoot = useCallback(async (): Promise<boolean> => {
    const opened = await openLastActiveRootAction();
    const rootId = useSpaceStore.getState().activeRootId;
    if (opened && rootId) {
      selectRootHome(rootId);
    }
    return opened;
  }, [openLastActiveRootAction, selectRootHome]);

  const openRootWindow = useCallback(
    async (id: string): Promise<void> => {
      await openRootWindowAction(id);
    },
    [openRootWindowAction],
  );

  const getWindowOpenIntent = useCallback(
    () => getWindowOpenIntentAction(),
    [getWindowOpenIntentAction],
  );

  const createRoot = useCallback(
    async (
      name: string,
      icon: string,
      description: string | undefined,
      path: string,
    ): Promise<SpaceInfo> => {
      const space = await createRootAction(name, icon, description, path);
      spaceNotifications.notifyProjectCreated();
      return space;
    },
    [createRootAction],
  );

  const deleteRoot = useCallback(
    async (id: string, deleteFiles?: boolean): Promise<void> => {
      await deleteRootAction(id, deleteFiles);
      spaceNotifications.notifyProjectDeleted();
    },
    [deleteRootAction],
  );

  const createSpace = useCallback(
    async (
      parentPath: string,
      name: string,
      icon: string,
      folderName: string,
      gitType: SpaceGitType,
    ): Promise<SpaceInfo> => {
      const space = await createSpaceAction(
        parentPath,
        name,
        icon,
        folderName,
        gitType,
      );
      openSpaceReadmeDocument(space.id);
      spaceNotifications.notifySpaceCreated();
      return space;
    },
    [createSpaceAction],
  );

  const deleteSpace = useCallback(
    async (
      parentPath: string,
      spaceId: string,
      deleteFiles?: boolean,
    ): Promise<void> => {
      await deleteSpaceAction(parentPath, spaceId, deleteFiles);
      spaceNotifications.notifySpaceDeleted();
    },
    [deleteSpaceAction],
  );

  const createEntry = useCallback(
    async (spacePath: string, title: string) => {
      const entry = await createEntryAction(spacePath, title);
      if (entry) {
        spaceNotifications.notifyPageCreated();
      } else {
        spaceNotifications.notifySpaceError();
      }
      return entry;
    },
    [createEntryAction],
  );

  return {
    createEntry,
    createRoot,
    createSpace,
    deleteRoot,
    deleteSpace,
    getWindowOpenIntent,
    openLastActiveRoot,
    openRoot,
    openRootWindow,
  };
}
