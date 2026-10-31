import { useEffect, useMemo, useSyncExternalStore } from "react";

import { repositoryAccessOwner } from "../model/repository-access-owner";

/**
 * The repository each of `spacePaths` belongs to, as its access snapshot
 * identifies it: an Inline Space shares the id of the project root, an
 * Independent or Submodule Space has its own. A path not read yet is absent.
 */
export function useRepositoryIds(
  spacePaths: readonly string[],
): Readonly<Record<string, string>> {
  const key = spacePaths.join("\n");
  useEffect(() => {
    for (const spacePath of key.split("\n").filter(Boolean)) {
      repositoryAccessOwner.retain(spacePath);
    }
  }, [key]);
  const read = () =>
    key
      .split("\n")
      .filter(Boolean)
      .map(
        (spacePath) =>
          repositoryAccessOwner.getSnapshot(spacePath).snapshot?.repositoryId ??
          "",
      )
      .join("\n");
  const ids = useSyncExternalStore(repositoryAccessOwner.subscribe, read, read);
  return useMemo(() => {
    const paths = key.split("\n").filter(Boolean);
    const values = ids.split("\n");
    return Object.fromEntries(
      paths.flatMap((spacePath, index) =>
        values[index] ? [[spacePath, values[index]]] : [],
      ),
    );
  }, [key, ids]);
}
