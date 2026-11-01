import { useEffect, useState } from "react";
import type { Page } from "@/features/page";
import { listItemsForView } from "../api";

export function useViewPlaceholderItems({
  spacePath,
  collectionPath,
  viewName,
  includeNested = false,
  projectPath,
  refreshToken,
}: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  includeNested?: boolean;
  projectPath?: string | null;
  refreshToken: number;
}) {
  const [items, setItems] = useState<Page[]>([]);

  useEffect(() => {
    let cancelled = false;

    listItemsForView({
      spacePath,
      collectionPath,
      viewName,
      includeNested,
      projectPath,
    })
      .then((nextItems) => {
        if (!cancelled) setItems(nextItems);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Failed to load view items:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    collectionPath,
    includeNested,
    projectPath,
    refreshToken,
    spacePath,
    viewName,
  ]);

  return items;
}
