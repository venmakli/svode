import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
} from "./keys";

/** A row of Now as its order knows it. */
export interface NowOrderRow {
  /** Key ids of the row's object; a shared id makes two rows one. */
  ids: readonly string[];
  /**
   * Ids that make a row continue an earlier one only when no row continues
   * it by `ids`: the terminal a pending session hands to its canonical one.
   */
  links?: readonly string[];
  /** The temporary main area object. */
  temporary?: boolean;
}

function shares(left: readonly string[], right: readonly string[]) {
  return left.some((id) => right.includes(id));
}

/**
 * The display order of `rows`, given in the order new rows take (DF-206):
 * a row shown before keeps its place, whatever its state became; a new row
 * comes last, before a temporary row that is last; a new temporary row is
 * last. Rows gone from `rows` drop out without moving the others.
 */
export function arrangeNowOrder(
  previous: readonly NowOrderRow[],
  rows: readonly NowOrderRow[],
): number[] {
  const place = rows.map(() => -1);
  const claimed = new Set<number>();
  const claim = (match: (entry: NowOrderRow, row: NowOrderRow) => boolean) => {
    rows.forEach((row, index) => {
      if (place[index] >= 0) return;
      const found = previous.findIndex(
        (entry, at) => !claimed.has(at) && match(entry, row),
      );
      if (found < 0) return;
      claimed.add(found);
      place[index] = found;
    });
  };
  claim((entry, row) => shares(entry.ids, row.ids));
  claim((entry, row) =>
    shares(
      [...entry.ids, ...(entry.links ?? [])],
      [...row.ids, ...(row.links ?? [])],
    ),
  );

  const indexes = rows.map((_, index) => index);
  const known = indexes
    .filter((index) => place[index] >= 0)
    .sort((left, right) => place[left] - place[right]);
  const fresh = indexes.filter(
    (index) => place[index] < 0 && !rows[index].temporary,
  );
  const freshTemporary = indexes.filter(
    (index) => place[index] < 0 && rows[index].temporary,
  );
  const last = known.at(-1);
  const order =
    last !== undefined && rows[last].temporary
      ? [...known.slice(0, -1), ...fresh, last]
      : [...known, ...fresh];
  return [...order, ...freshTemporary];
}

/**
 * The owner of the Now order of each project in this window: the rows as a
 * surface of the project last showed them. It outlives the sidebar and Home
 * surfaces, so the order of rows that are not kept survives switching
 * between them (DF-206 R6); it is not saved.
 */
const orders = new Map<string, readonly NowOrderRow[]>();

export function nowOrderOf(projectPath: string): readonly NowOrderRow[] {
  return orders.get(projectPath) ?? [];
}

export function recordNowOrder(
  projectPath: string,
  rows: readonly NowOrderRow[],
) {
  orders.set(projectPath, rows);
}

/**
 * The kept item to keep `key` before, so that a row Now shows keeps its
 * place among the kept items shown below it (DF-206 R5); null when Now
 * does not show the row or no kept item is below it.
 */
export function nowKeepPlace(
  projectPath: string,
  key: NavigationKey,
  kept: readonly NavigationItem[],
): NavigationKey | null {
  const order = nowOrderOf(projectPath);
  const placeOf = (id: string) =>
    order.findIndex((row) => row.ids.includes(id));
  const at = placeOf(navigationKeyId(key));
  if (at < 0) return null;
  let before: { key: NavigationKey; place: number } | null = null;
  for (const item of kept) {
    const place = placeOf(navigationKeyId(item.key));
    if (place > at && (before === null || place < before.place)) {
      before = { key: item.key, place };
    }
  }
  return before?.key ?? null;
}
