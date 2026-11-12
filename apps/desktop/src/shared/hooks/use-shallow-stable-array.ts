import { useState } from "react";

/**
 * The array of the previous render while a new one holds the same items, so
 * consumers that compare by reference do not see a change.
 */
export function useShallowStableArray<T>(items: T[]): T[] {
  const [stable, setStable] = useState(items);
  const same =
    stable === items ||
    (stable.length === items.length &&
      stable.every((item, index) => item === items[index]));
  if (!same) setStable(items);
  return same ? stable : items;
}
