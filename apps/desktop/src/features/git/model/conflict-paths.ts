import { normalizeGitStatusPath } from "./git-paths";
import type { GitConflictKind, GitPathConflict } from "./types";

/** Whether a conflict of `kind` at `path` is resolved in the Page editor. */
export function conflictInPageEditor(
  path: string,
  kind: GitConflictKind | undefined,
): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  return (
    kind === undefined ||
    kind === "page_text" ||
    kind === "page_properties" ||
    kind === "add_add"
  );
}

/**
 * Whether a write of the file decides a conflict of `kind`: the kinds whose
 * dispute stands in marker lines, so a written file without them is the
 * decided result (DF-294 R5). Modify/delete, rename conflicts, binary files
 * and Space pointers wait for an explicit choice (DF-354 R1).
 */
export function conflictResolvedByEditorWrite(kind: GitConflictKind): boolean {
  return (
    kind === "page_text" ||
    kind === "page_properties" ||
    kind === "text" ||
    kind === "add_add"
  );
}

/**
 * The kind of the conflict that holds `path`, at its entry or as another
 * path of it; null when none of `conflicts` holds it.
 */
export function gitPathConflictKind(
  conflicts: Iterable<GitPathConflict>,
  path: string,
): GitConflictKind | null {
  const target = normalizeGitStatusPath(path);
  for (const conflict of conflicts)
    if (
      normalizeGitStatusPath(conflict.path) === target ||
      conflict.also?.some((other) => normalizeGitStatusPath(other) === target)
    )
      return conflict.kind;
  return null;
}

/**
 * The paths resolved with another path of their conflict, which lists them
 * as its own: the original and the incoming name of a rename/rename
 * conflict. Lists of conflicts show the conflict once, at its entry.
 */
export function conflictPartners(
  conflicts: Iterable<GitPathConflict>,
): ReadonlySet<string> {
  const partners = new Set<string>();
  for (const conflict of conflicts)
    for (const path of conflict.also ?? []) partners.add(path);
  return partners;
}
