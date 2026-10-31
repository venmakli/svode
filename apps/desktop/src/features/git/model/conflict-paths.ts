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
 * Whether a conflicted path has its own place of resolution yet: a project
 * or Space config is chosen by places only from 1.19.
 */
export function conflictResolvable(path: string): boolean {
  return path !== ".svode/config.json" && !path.endsWith("/.svode/config.json");
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
