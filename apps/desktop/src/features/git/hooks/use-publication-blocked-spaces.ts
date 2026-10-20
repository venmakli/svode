import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useSpace } from "@/features/space";
import {
  publicationBlockedSpaces,
  publicationBlockSpacePaths,
  type GitPublicationBlock,
  type PublicationBlockContext,
} from "../model/publication-block";
import { repositoryAccessOwner } from "../model/repository-access-owner";

/**
 * The Spaces of a publication refusal named by the project's Spaces, with the
 * locally known access of each: a confirmed read-only Space is not publishable.
 */
export function usePublicationBlockedSpaces(block: GitPublicationBlock) {
  const context = useSpace(
    (state): PublicationBlockContext => ({
      projectPath: state.activeRootPath,
      spaces: state.spaces,
    }),
  );
  const pathsKey = publicationBlockSpacePaths(block, context).join("\n");
  // Only the local access snapshot is read; checking a remote stays with the Space.
  useEffect(() => {
    for (const path of pathsKey.split("\n"))
      if (path) repositoryAccessOwner.retain(path);
  }, [pathsKey]);
  const readOnlyKey = useSyncExternalStore(
    repositoryAccessOwner.subscribe,
    () => readOnlyPaths(pathsKey),
    () => readOnlyPaths(pathsKey),
  );
  return useMemo(
    () =>
      publicationBlockedSpaces(
        block,
        context,
        new Set(readOnlyKey.split("\n").filter(Boolean)),
      ),
    [block, context, readOnlyKey],
  );
}

function readOnlyPaths(pathsKey: string) {
  return pathsKey
    .split("\n")
    .filter(
      (path) =>
        !!path &&
        repositoryAccessOwner.getSnapshot(path).snapshot?.status ===
          "read_only",
    )
    .join("\n");
}
