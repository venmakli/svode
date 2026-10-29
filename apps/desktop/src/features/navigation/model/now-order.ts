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
  /**
   * Signs of a row the user may hide, such as an active session that works,
   * waits for the user, shows in the main area or is kept: a hidden row
   * comes back once one of them turns on (DF-207 R2). A row without signs
   * cannot stay hidden.
   */
  signs?: readonly boolean[];
  /**
   * The row stays in Now once it would leave by itself, such as an active
   * session that is not kept: it ends kept in its place (DF-210 R1).
   */
  stays?: boolean;
  /**
   * The row ended and is kept in its place by this item: it shows while the
   * keep is in flight, and leaves Now if the keep fails.
   */
  keep?: NavigationItem;
}

function shares(left: readonly string[], right: readonly string[]) {
  return left.some((id) => right.includes(id));
}

/**
 * The earlier row each of `rows` continues, or -1: by a shared id first,
 * then by a link.
 */
function continuedRows(
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
  return place;
}

/**
 * Which of `rows` continue a row of `previous` that stays in Now once it
 * ends (DF-210 R1).
 */
export function continuesStayingNowRows(
  previous: readonly NowOrderRow[],
  rows: readonly NowOrderRow[],
): boolean[] {
  const staying = previous.filter((row) => row.stays);
  if (staying.length === 0) return rows.map(() => false);
  return continuedRows(staying, rows).map((place) => place >= 0);
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
  const place = continuedRows(previous, rows);
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
 * Which of `rows` stay hidden after the rows `hidden` were hidden, and the
 * hidden rows to remember now (DF-207 R2): a hidden row stays hidden while
 * it has signs and none turned on since; it comes back once one does, and
 * is forgotten once it is gone or has no signs.
 */
export function settleHiddenNowRows(
  hidden: readonly NowOrderRow[],
  rows: readonly NowOrderRow[],
): { hidden: boolean[]; marks: NowOrderRow[] } {
  const place = continuedRows(hidden, rows);
  const marks: NowOrderRow[] = [];
  const stays = rows.map((row, index) => {
    const mark = hidden[place[index]];
    if (!mark || !row.signs) return false;
    const event = row.signs.some((sign, at) => sign && !mark.signs?.[at]);
    if (event) return false;
    marks.push(row);
    return true;
  });
  return { hidden: stays, marks };
}

/**
 * The owner of Now of each project in this window: the order of its rows as
 * a surface of the project last showed them, and the rows the user hid. It
 * outlives the sidebar and Home surfaces, so both survive switching between
 * them (DF-206 R6, DF-207 R4); neither is saved.
 */
const orders = new Map<string, readonly NowOrderRow[]>();
const hiddenRows = new Map<string, readonly NowOrderRow[]>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

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
 * Drops a row from the order of Now of the project, such as an ended row
 * whose keep failed: surfaces of the project show Now without it.
 */
export function dropNowRow(projectPath: string, row: NowOrderRow) {
  const order = nowOrderOf(projectPath);
  const [place] = continuedRows(order, [row]);
  if (place < 0) return;
  orders.set(projectPath, order.filter((_, at) => at !== place));
  notify();
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

export function nowHiddenOf(projectPath: string): readonly NowOrderRow[] {
  return hiddenRows.get(projectPath) ?? [];
}

/** Hides a row of Now until a new event of its signs (DF-207 R2). */
export function hideNowRow(projectPath: string, row: NowOrderRow) {
  const kept = nowHiddenOf(projectPath).filter(
    (mark) => continuedRows([mark], [row])[0] < 0,
  );
  hiddenRows.set(projectPath, [...kept, row]);
  notify();
}

/** Remembers the hidden rows a surface settled; its render already shows them. */
export function recordNowHidden(
  projectPath: string,
  rows: readonly NowOrderRow[],
) {
  hiddenRows.set(projectPath, rows);
}

/** Calls the listener when a row of Now is hidden or dropped. */
export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function nowRevision(): number {
  return version;
}
