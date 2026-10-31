import { conflictPartners } from "./conflict-paths";
import type { GitConflictKind, GitPathConflict, GitServiceFile } from "./types";

/**
 * What Svode hands an agent to resolve (Stage 11 1.F): a merge stopped at
 * conflicts, or files left in conflict with no Git operation.
 */
export type ConflictAgentSituation = { kind: "merge" } | { kind: "unmerged" };

/**
 * A conflict the agent resolves: its path, the other paths of the same
 * conflict (both names of a rename/rename) and its kind when known.
 */
export interface ConflictForAgent {
  path: string;
  also: string[];
  kind: GitConflictKind | undefined;
}

/**
 * The unresolved conflicts of `files` an agent resolves, in their order:
 * a conflict of several paths once, at its entry, and none of the Svode
 * service files in `service`, which Svode merges (1.C) and the agent does
 * not edit (1.D).
 */
export function conflictsForAgent(
  files: readonly string[],
  kinds: readonly GitPathConflict[],
  service: readonly GitServiceFile[] = [],
): ConflictForAgent[] {
  const byPath = new Map(kinds.map((conflict) => [conflict.path, conflict]));
  const partners = conflictPartners(kinds);
  const serviceFiles = new Set(service.map((file) => file.path));
  return files
    .filter((path) => !partners.has(path) && !serviceFiles.has(path))
    .map((path) => ({
      path,
      also: byPath.get(path)?.also ?? [],
      kind: byPath.get(path)?.kind,
    }));
}
