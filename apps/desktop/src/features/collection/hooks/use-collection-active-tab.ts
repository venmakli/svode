import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionSchema } from "@/features/properties";
import type { ActiveTab, CollectionRouteState } from "../model";
import type { CollectionView } from "../query";

export function resolveCollectionViewName(
  requestedViewName: string | null,
  views: readonly Pick<CollectionView, "name">[],
): string | null {
  if (
    requestedViewName &&
    views.some((view) => view.name === requestedViewName)
  ) {
    return requestedViewName;
  }
  return views[0]?.name ?? null;
}

export function useCollectionActiveTab({
  collectionPath,
  routeState,
  schema,
  views,
}: {
  collectionPath: string;
  routeState?: CollectionRouteState;
  schema: CollectionSchema | null;
  views: CollectionView[];
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("");
  const initializedCollectionRef = useRef<string | null>(null);
  const requestedViewName = routeState?.viewName ?? null;
  const onViewNameChange = routeState?.onViewNameChange;

  const selectTab = useCallback(
    (next: ActiveTab) => {
      setActiveTab(next);
      onViewNameChange?.(next || null);
    },
    [onViewNameChange],
  );

  useEffect(() => {
    if (!schema) return;
    const key = collectionPath;
    const resolvedViewName = resolveCollectionViewName(
      requestedViewName,
      views,
    );
    const fallbackTab = resolvedViewName ?? "";
    const requestedIsValid = Boolean(
      requestedViewName && resolvedViewName === requestedViewName,
    );

    if (initializedCollectionRef.current === key) {
      if (routeState) {
        if (requestedViewName && requestedIsValid) {
          if (activeTab !== requestedViewName) {
            queueMicrotask(() => setActiveTab(requestedViewName));
          }
          return;
        }
        if (requestedViewName && !requestedIsValid) {
          queueMicrotask(() => selectTab(fallbackTab));
          return;
        }
        if (!requestedViewName && activeTab !== fallbackTab) {
          queueMicrotask(() => setActiveTab(fallbackTab));
          return;
        }
      }
      if (
        activeTab && !views.some((view) => view.name === activeTab)
      ) {
        queueMicrotask(() => selectTab(fallbackTab));
      }
      return;
    }

    initializedCollectionRef.current = key;
    if (requestedViewName && requestedIsValid) {
      queueMicrotask(() => setActiveTab(requestedViewName));
      return;
    }
    queueMicrotask(() => selectTab(fallbackTab));
  }, [
    activeTab,
    collectionPath,
    requestedViewName,
    schema,
    selectTab,
    routeState,
    views,
  ]);

  return { activeTab, selectTab };
}
