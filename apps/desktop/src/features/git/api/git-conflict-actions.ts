import {
  getGitAgentRules,
  getGitConflictFile,
  getGitConflictKinds,
  resolveGitConflictFile as resolvePlatformGitConflictFile,
} from "@/platform/git/git-api";
import {
  conflictEditedSide,
  gitPathConflictKind,
  type GitConflictFile,
  type GitConflictKind,
  type GitFileResolution,
  type GitPathConflict,
  type GitSyncOutcome,
} from "../model";
import { runSync } from "./git-actions";

/** The unresolved paths under `spacePath`, relative to it, with their kinds. */
export async function readGitConflictKinds(
  spacePath: string,
): Promise<GitPathConflict[]> {
  return (await getGitConflictKinds(spacePath)).map((file) => ({ ...file }));
}

/**
 * The kind of the conflict that holds `path` (relative to `spacePath`), read
 * from Git; null when Git does not hold it unresolved.
 */
export async function readGitPathConflictKind(
  spacePath: string,
  path: string,
): Promise<GitConflictKind | null> {
  return gitPathConflictKind(await readGitConflictKinds(spacePath), path);
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
    binary: dto.binary,
    changes: dto.changes
      ? { ours: { ...dto.changes.ours }, theirs: { ...dto.changes.theirs } }
      : null,
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

/**
 * The choice in a conflict of an edit against a deletion as "Changes" make
 * it: «Оставить с правками» keeps the file of the side that edited it as it
 * is now on disk, with every edit made before the choice (the version of
 * that side when there is no file), «Удалить» removes the path.
 */
export function resolveGitDeletionConflict(
  spacePath: string,
  path: string,
  file: Pick<GitConflictFile, "ours">,
  choice: "keep" | "delete",
): Promise<GitSyncOutcome> {
  return resolveGitConflictFile(
    spacePath,
    path,
    choice === "delete"
      ? { type: "delete" }
      : { type: "side", side: conflictEditedSide(file) },
  );
}

/**
 * The Git rules for agents (1.D) in the words of the guide and the Svode
 * skill, which «Разрешить с агентом» puts into its request.
 */
export function readGitAgentRules(): Promise<string> {
  return getGitAgentRules();
}
