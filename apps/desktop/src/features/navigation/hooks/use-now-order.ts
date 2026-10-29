import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { navigationKeyId } from "../model/keys";
import type { NavigationStoreState } from "../model/navigation-store";
import {
  arrangeNowOrder,
  dropNowRow,
  nowHiddenOf,
  nowOrderOf,
  nowRevision,
  recordNowHidden,
  recordNowOrder,
  settleHiddenNowRows,
  subscribeNow,
  type NowOrderRow,
} from "../model/now-order";
import { useNavigationState } from "./use-navigation-state";
import * as m from "@/paraglide/messages.js";

/**
 * The Now rows of a project to show, in display order, as indexes into
 * `rows`, which are given in the order new rows take; rows the user hid
 * stay out until a new event brings them back, and an ended row is kept in
 * its place (DF-210 R1). The order and the hidden rows are recorded for the
 * project in this window, so every surface of the project shows Now alike
 * (DF-206, DF-207). Rows read only in part, such as before the project's
 * sessions are read, are shown by the record without changing it: a row
 * missing from them has not left Now.
 */
export function useNowOrder(
  projectPath: string | null,
  rows: readonly NowOrderRow[],
  complete: boolean,
): number[] {
  useSyncExternalStore(subscribeNow, nowRevision);
  const keep = useNavigationState((state) => state.keep);
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
    if (!projectPath || !settled || !complete) return;
    recordNowOrder(projectPath, shown);
    recordNowHidden(projectPath, settled.marks);
  });
  // After the record, so the keep finds the row's place among kept items.
  useEffect(() => {
    if (!projectPath || !complete) return;
    for (const row of shown) {
      if (row.keep) keepEndedRow(projectPath, row, keep);
    }
  });
  return order;
}

/** Ended rows whose keep is in flight, by project and key id. */
const keeping = new Set<string>();

/**
 * Keeps an ended row once, whichever surface of its project asks first; a
 * failed keep drops the row from Now.
 */
function keepEndedRow(
  projectPath: string,
  row: NowOrderRow,
  keep: NavigationStoreState["keep"],
) {
  const item = row.keep;
  if (!item) return;
  const id = JSON.stringify([projectPath, navigationKeyId(item.key)]);
  if (keeping.has(id)) return;
  keeping.add(id);
  keep(item)
    .catch((error: unknown) => {
      dropNowRow(projectPath, row);
      toast.error(m.navigation_keep_failed(), {
        description: getNativeErrorMessage(error),
      });
    })
    .finally(() => keeping.delete(id));
}
