import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calendarScopes,
  type CalendarScope,
  type CollectionRouteState,
} from "@/features/collection/app-shell";

interface CollectionRouteSnapshot {
  viewName: string | null;
  calendarScope: CalendarScope | null;
}

type CollectionRoutePatch = Partial<CollectionRouteSnapshot>;

export function useCollectionRouteState(): CollectionRouteState {
  const [snapshot, setSnapshot] = useState(readCollectionRouteSnapshot);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function syncFromLocation() {
      setSnapshot(readCollectionRouteSnapshot());
    }
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  const updateViewName = useCallback((viewName: string | null) => {
    setSnapshot(writeCollectionRoutePatch({ viewName }));
  }, []);

  const updateCalendarScope = useCallback((calendarScope: CalendarScope) => {
    setSnapshot(writeCollectionRoutePatch({ calendarScope }));
  }, []);

  return useMemo(
    () => ({
      viewName: snapshot.viewName,
      onViewNameChange: updateViewName,
      calendarScope: snapshot.calendarScope,
      onCalendarScopeChange: updateCalendarScope,
    }),
    [
      snapshot.calendarScope,
      snapshot.viewName,
      updateCalendarScope,
      updateViewName,
    ],
  );
}

function readCollectionRouteSnapshot(): CollectionRouteSnapshot {
  if (typeof window === "undefined") {
    return { viewName: null, calendarScope: null };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    viewName: normalizeViewName(params.get("view")),
    calendarScope: normalizeCalendarScopeParam(params.get("scope")),
  };
}

function writeCollectionRoutePatch(
  patch: CollectionRoutePatch,
): CollectionRouteSnapshot {
  if (typeof window === "undefined") {
    return readCollectionRouteSnapshot();
  }
  const url = new URL(window.location.href);

  if (Object.prototype.hasOwnProperty.call(patch, "viewName")) {
    const viewName = normalizeViewName(patch.viewName ?? null);
    if (viewName) url.searchParams.set("view", viewName);
    else url.searchParams.delete("view");
  }

  if (Object.prototype.hasOwnProperty.call(patch, "calendarScope")) {
    const scope = patch.calendarScope;
    if (scope) url.searchParams.set("scope", scope);
    else url.searchParams.delete("scope");
  }

  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return readCollectionRouteSnapshot();
}

function normalizeViewName(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function normalizeCalendarScopeParam(value: string | null): CalendarScope | null {
  return calendarScopes.includes(value as CalendarScope)
    ? (value as CalendarScope)
    : null;
}
