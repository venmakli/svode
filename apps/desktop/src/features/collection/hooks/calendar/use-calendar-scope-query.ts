import { useCallback, useEffect, useState } from "react";
import type { CollectionView } from "@/features/collection/query/model";
import type { CalendarScope } from "../../model/calendar-types";
import { normalizeCalendarScope } from "../../model/calendar-utils";

interface CalendarScopeRouteState {
  calendarScope: CalendarScope | null;
  onCalendarScopeChange: (scope: CalendarScope) => void;
}

export function useCalendarScopeQuery(
  view: CollectionView,
  routeState?: CalendarScopeRouteState,
) {
  const [scope, setScope] = useState<CalendarScope>(() =>
    normalizeCalendarScope(view.default_scope),
  );
  const controlledScope = routeState?.calendarScope ?? null;
  const effectiveScope = controlledScope ?? scope;

  useEffect(() => {
    if (!routeState || controlledScope) return;
    routeState.onCalendarScopeChange(effectiveScope);
  }, [controlledScope, effectiveScope, routeState]);

  const updateScope = useCallback(
    (nextScope: CalendarScope) => {
      setScope(nextScope);
      routeState?.onCalendarScopeChange(nextScope);
    },
    [routeState],
  );

  return [effectiveScope, updateScope] as const;
}
