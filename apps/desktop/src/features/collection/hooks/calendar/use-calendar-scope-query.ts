import { useEffect, useState } from "react";
import type { CollectionView } from "@/features/collection/query/model";
import type { CalendarScope } from "../../model/calendar-types";
import {
  calendarScopes,
  normalizeCalendarScope,
} from "../../model/calendar-utils";

export function useCalendarScopeQuery(view: CollectionView) {
  const [scope, setScope] = useState<CalendarScope>(() =>
    readCalendarScopeQuery() ?? normalizeCalendarScope(view.default_scope),
  );

  useEffect(() => {
    writeCalendarScopeQuery(scope);
  }, [scope]);

  return [scope, setScope] as const;
}

function readCalendarScopeQuery() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const queryScope = params.get("scope");
  return calendarScopes.includes(queryScope as CalendarScope)
    ? (queryScope as CalendarScope)
    : null;
}

function writeCalendarScopeQuery(scope: CalendarScope) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("scope", scope);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}
