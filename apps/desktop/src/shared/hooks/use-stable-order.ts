import { useState } from "react";
import { holdOrder } from "@/shared/lib/stable-order";

function sameOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * The ids in their current order, or, while `hold` is set, in the order they
 * were last shown: known ids keep their place and new ones come last. The
 * accumulated order applies once the hold ends.
 */
export function useStableOrder(
  ids: readonly string[],
  hold: boolean,
): readonly string[] {
  const [shown, setShown] = useState<readonly string[]>(ids);
  const order = hold ? holdOrder(shown, ids) : ids;
  if (!sameOrder(order, shown)) setShown(order);
  return order;
}
