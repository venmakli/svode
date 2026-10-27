import { useLayoutEffect } from "react";
import {
  arrangeNowOrder,
  nowOrderOf,
  recordNowOrder,
  type NowOrderRow,
} from "../model/now-order";

/**
 * The display order of the Now rows of a project, as indexes into `rows`,
 * which are given in the order new rows take. The order is recorded for the
 * project in this window, so every surface of the project shows Now in one
 * order (DF-206).
 */
export function useNowOrder(
  projectPath: string | null,
  rows: readonly NowOrderRow[],
): number[] {
  const order = projectPath
    ? arrangeNowOrder(nowOrderOf(projectPath), rows)
    : rows.map((_, index) => index);
  const shown = order.map((index) => rows[index]);
  useLayoutEffect(() => {
    if (projectPath) recordNowOrder(projectPath, shown);
  });
  return order;
}
