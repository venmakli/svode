import {
  getGitConflictFile,
  getGitConflictKinds,
  resolveGitConflictFile as resolvePlatformGitConflictFile,
} from "@/platform/git/git-api";
import type {
  GitConflictFile,
  GitFileResolution,
  GitPathConflict,
  GitSyncOutcome,
} from "../model";
import { runSync } from "./git-actions";

/** The unresolved paths under `spacePath`, relative to it, with their kinds. */
export async function readGitConflictKinds(
  spacePath: string,
): Promise<GitPathConflict[]> {
  return (await getGitConflictKinds(spacePath)).map((file) => ({ ...file }));
}

/** The conflicted file at `path` (relative to `spacePath`) with its places. */
export async function readGitConflictFile(
  spacePath: string,
  path: string,
): Promise<GitConflictFile> {
  const dto = await getGitConflictFile({ spacePath, path });
  return {
    path: dto.path,
    kind: dto.kind,
    version: dto.version,
    content: dto.content,
    places: dto.places
      ? dto.places.type === "places"
        ? {
            type: "places",
            places: dto.places.places.map((place) => ({ ...place })),
          }
        : { type: "unclear", reason: dto.places.reason }
      : null,
    ours: dto.ours,
    theirs: dto.theirs,
  };
}

/**
 * Resolve a conflicted text file by the person's choice; the last resolved
 * path finishes the merge and publishes it, as resolving a Page does.
 */
export function resolveGitConflictFile(
  spacePath: string,
  path: string,
  resolution: GitFileResolution,
): Promise<GitSyncOutcome> {
  return runSync(spacePath, () =>
    resolvePlatformGitConflictFile({ spacePath, path, resolution }),
  );
}
