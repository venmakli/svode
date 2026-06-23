import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionSchema } from "@/features/properties";
import type { ActiveTab } from "../model";
import type { CollectionView } from "../query";

export function useCollectionActiveTab({
  collectionPath,
  hasReadme,
  schema,
  views,
}: {
  collectionPath: string;
  hasReadme: boolean;
  schema: CollectionSchema | null;
  views: CollectionView[];
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("document");
  const initializedCollectionRef = useRef<string | null>(null);

  const selectTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "document") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  useEffect(() => {
    if (!schema) return;
    const key = `${collectionPath}:${hasReadme ? "readme" : "no-readme"}`;
    if (initializedCollectionRef.current === key) {
      if (
        activeTab !== "document" &&
        !views.some((view) => view.name === activeTab)
      ) {
        queueMicrotask(() =>
          selectTab(hasReadme ? "document" : (views[0]?.name ?? "document")),
        );
      }
      return;
    }
    initializedCollectionRef.current = key;
    const params =
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search);
    const requested = params.get("view");
    if (requested && views.some((view) => view.name === requested)) {
      queueMicrotask(() => selectTab(requested));
      return;
    }
    if (hasReadme) {
      queueMicrotask(() => selectTab("document"));
      return;
    }
    queueMicrotask(() => selectTab(views[0]?.name ?? "document"));
  }, [activeTab, collectionPath, hasReadme, schema, selectTab, views]);

  return { activeTab, selectTab };
}
