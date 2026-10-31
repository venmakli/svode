import type { GitConflictKind } from "./types";

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
