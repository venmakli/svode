import { lastWhere, type TimelineEntry, type TimelineTurn } from "./timeline";

/** Expansion the user set by hand, by entry id; it outranks automation. */
export type ManualExpansion = Readonly<Record<string, boolean>>;

/**
 * Whether an entry opens by itself (Stage 10 `04`, automatic expansion):
 * the live edge of a running turn — its reasoning or current group of tool
 * calls — and the last error of a turn with its detail. Everything else
 * stays folded until the user opens it.
 */
export function autoExpanded(turn: TimelineTurn, entry: TimelineEntry): boolean {
  if (turn.live && turn.entries.at(-1)?.id === entry.id) {
    return entry.kind === "reasoning" || entry.kind === "tools";
  }
  if (entry.kind === "notice" && entry.item.kind === "error") {
    const lastError = lastWhere(
      turn.entries,
      (candidate) =>
        candidate.kind === "notice" && candidate.item.kind === "error",
    );
    return (
      lastError?.id === entry.id &&
      (entry.item.summary.length > 0 || entry.item.hasDetail)
    );
  }
  return false;
}

/** The user's choice when they made one, else the automatic state. */
export function isExpanded(
  manual: ManualExpansion,
  turn: TimelineTurn,
  entry: TimelineEntry,
): boolean {
  return manual[entry.id] ?? autoExpanded(turn, entry);
}

/** Key of a turn's summary row in the manual expansion. */
export function summaryKey(turn: TimelineTurn): string {
  return `summary:${turn.id}`;
}

/** Key of a turn's changed files row in the manual expansion. */
export function changedFilesKey(turn: TimelineTurn): string {
  return `files:${turn.id}`;
}

/** A folded turn opens only by the user's hand. */
export function isSummaryExpanded(
  manual: ManualExpansion,
  turn: TimelineTurn,
): boolean {
  return manual[summaryKey(turn)] ?? false;
}

/**
 * The entries a turn shows: all of them, or only the visible ones while
 * folded, where each row of created media stands on its own (`08` R2).
 */
export function shownEntries(
  manual: ManualExpansion,
  turn: TimelineTurn,
): TimelineEntry[] {
  if (!turn.summary || isSummaryExpanded(manual, turn)) return turn.entries;
  const { visibleIds, mediaRowIds } = turn.summary;
  const shown: TimelineEntry[] = [];
  for (const entry of turn.entries) {
    if (visibleIds.has(entry.id)) {
      shown.push(entry);
    } else if (entry.kind === "tools") {
      for (const row of entry.rows) {
        if (mediaRowIds.has(row.item.id)) {
          shown.push({ kind: "tools", id: row.item.id, rows: [row] });
        }
      }
    }
  }
  return shown;
}
