import { useCallback } from "react";
import { useSpaceStore } from "../model";
import { useSpaceScopeActions } from "./use-space-scope-actions";

const noop = () => undefined;

export function useRootDocumentActions() {
  const {
    activeRootId,
    activeRootPath,
    fileTrees,
    reloadTreeParent,
    loadTreeChildren,
  } = useSpaceStore();
  const tree = activeRootId ? (fileTrees[activeRootId] ?? []) : [];

  const {
    handleNewCollection: handleScopeNewCollection,
    handleNewFolder: handleScopeNewFolder,
    handleNewPage: handleScopeNewPage,
  } = useSpaceScopeActions({
    activeRootPath,
    onActivateContent: noop,
    reloadTreeParent,
  });

  const handleNewPage = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    await handleScopeNewPage({ id: activeRootId, path: activeRootPath });
  }, [activeRootId, activeRootPath, handleScopeNewPage]);

  const handleNewFolder = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    await handleScopeNewFolder({ id: activeRootId, path: activeRootPath });
  }, [activeRootId, activeRootPath, handleScopeNewFolder]);

  const handleNewCollection = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    await handleScopeNewCollection({ id: activeRootId, path: activeRootPath });
  }, [activeRootId, activeRootPath, handleScopeNewCollection]);

  return {
    activeRootId,
    activeRootPath,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    loadTreeChildren,
    tree,
  };
}
