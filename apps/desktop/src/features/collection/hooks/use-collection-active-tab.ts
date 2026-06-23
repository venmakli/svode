import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionSchema } from "@/features/properties";
import type { ActiveTab, CollectionRouteState } from "../model";
import type { CollectionView } from "../query";

export function useCollectionActiveTab({
  collectionPath,
  hasReadme,
  routeState,
  schema,
  views,
}: {
  collectionPath: string;
  hasReadme: boolean;
  routeState?: CollectionRouteState;
  schema: CollectionSchema | null;
  views: CollectionView[];
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("document");
  const initializedCollectionRef = useRef<string | null>(null);
  const requestedViewName = routeState?.viewName ?? null;
  const onViewNameChange = routeState?.onViewNameChange;

  const selectTab = useCallback(
    (next: ActiveTab) => {
      setActiveTab(next);
      onViewNameChange?.(next === "document" ? null : next);
    },
    [onViewNameChange],
  );

  useEffect(() => {
    if (!schema) return;
    const key = `${collectionPath}:${hasReadme ? "readme" : "no-readme"}`;
    const fallbackTab = hasReadme ? "document" : (views[0]?.name ?? "document");
    const requestedIsValid = Boolean(
      requestedViewName && views.some((view) => view.name === requestedViewName),
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
        activeTab !== "document" &&
        !views.some((view) => view.name === activeTab)
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
    hasReadme,
    requestedViewName,
    schema,
    selectTab,
    routeState,
    views,
  ]);

  return { activeTab, selectTab };
}
