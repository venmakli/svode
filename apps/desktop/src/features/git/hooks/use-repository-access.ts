import { useCallback, useEffect, useSyncExternalStore } from "react";

import { repositoryAccessOwner } from "../model/repository-access-owner";

export function useRepositoryAccess(spacePath: string) {
  const state = useSyncExternalStore(
    repositoryAccessOwner.subscribe,
    () => repositoryAccessOwner.getSnapshot(spacePath),
    () => repositoryAccessOwner.getSnapshot(spacePath),
  );

  useEffect(() => repositoryAccessOwner.retain(spacePath), [spacePath]);

  useEffect(() => {
    const handleFocus = () => void repositoryAccessOwner.refresh(spacePath);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [spacePath]);

  const verify = useCallback(
    () => repositoryAccessOwner.verify(spacePath),
    [spacePath],
  );
  const refresh = useCallback(
    () => repositoryAccessOwner.refresh(spacePath),
    [spacePath],
  );

  return { ...state, refresh, verify };
}
