import { useState } from "react";

import type { ScopeOwnerKey } from "@/features/scope-surfaces";

/**
 * The owner key the shown owner replaced within one open request, as a
 * marker of its folder came or went. Another request starts with none.
 */
export function useReplacedOwnerKey(
  requestKey: number | undefined,
  ownerKey: ScopeOwnerKey | undefined,
): ScopeOwnerKey | undefined {
  const [shown, setShown] = useState<{
    requestKey: number | undefined;
    ownerKey: ScopeOwnerKey | undefined;
    replaced: ScopeOwnerKey | undefined;
  }>({ requestKey, ownerKey, replaced: undefined });
  if (
    requestKey !== undefined &&
    ownerKey !== undefined &&
    (shown.requestKey !== requestKey || shown.ownerKey !== ownerKey)
  ) {
    setShown({
      requestKey,
      ownerKey,
      replaced: shown.requestKey === requestKey ? shown.ownerKey : undefined,
    });
  }
  return requestKey !== undefined && shown.requestKey === requestKey
    ? shown.replaced
    : undefined;
}
