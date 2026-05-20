import { useMemo } from "react";
import type { QueryFilter, QuerySort } from "../model/types";

export function useStableViewQueryArgs(
  filters: QueryFilter[],
  sort: QuerySort[],
) {
  const key = useMemo(() => JSON.stringify({ filters, sort }), [filters, sort]);

  // The serialized key is the dependency: callers should not refetch when
  // parent renders produce new arrays with identical query content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ filters, sort }), [key]);
}
