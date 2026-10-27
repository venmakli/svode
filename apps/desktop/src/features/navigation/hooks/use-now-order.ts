import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  arrangeNowOrder,
  nowHiddenOf,
  nowHiddenRevision,
  nowOrderOf,
  recordNowHidden,
  recordNowOrder,
  settleHiddenNowRows,
  subscribeNowHidden,
  type NowOrderRow,
} from "../model/now-order";

/**
 * The Now rows of a project to show, in display order, as indexes into
 * `rows`, which are given in the order new rows take; rows the user hid
 * stay out until a new event brings them back. The order and the hidden
 * rows are recorded for the project in this window, so every surface of
 * the project shows Now alike (DF-206, DF-207).
 */
export function useNowOrder(
  projectPath: string | null,
  rows: readonly NowOrderRow[],
): number[] {
  useSyncExternalStore(subscribeNowHidden, nowHiddenRevision);
  const settled = projectPath
    ? settleHiddenNowRows(nowHiddenOf(projectPath), rows)
    : null;
  const visible = rows.flatMap((_, index) =>
    settled?.hidden[index] ? [] : [index],
  );
  const order = projectPath
    ? arrangeNowOrder(
        nowOrderOf(projectPath),
        visible.map((index) => rows[index]),
      ).map((at) => visible[at])
    : visible;
  const shown = order.map((index) => rows[index]);
  useLayoutEffect(() => {
    if (!projectPath || !settled) return;
    recordNowOrder(projectPath, shown);
    recordNowHidden(projectPath, settled.marks);
  });
  return order;
}
