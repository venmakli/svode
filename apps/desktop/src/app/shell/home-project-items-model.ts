import type { NavigationResolvedItem } from "@/features/navigation";
import type { NowRow } from "./now-model";

/** A row under an expanded project of the Home sidebar. */
export type HomeProjectRow =
  | { kind: "pinned"; item: NavigationResolvedItem }
  | NowRow;

/**
 * The one flat list under an expanded project: its pins in pin order, then
 * its Now in the order the project's surfaces share. Only the active
 * project has a main area object, so only it has a temporary row.
 */
export function homeProjectRows(
  pinned: readonly NavigationResolvedItem[],
  now: readonly NowRow[],
): HomeProjectRow[] {
  return [...pinned.map((item) => ({ kind: "pinned" as const, item })), ...now];
}
