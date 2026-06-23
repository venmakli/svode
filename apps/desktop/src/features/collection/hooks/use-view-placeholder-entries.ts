import { useEffect, useState } from "react";
import type { Entry } from "@/features/entry";
import { listEntriesForView } from "../api";

export function useViewPlaceholderEntries({
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
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    let cancelled = false;

    listEntriesForView({
      spacePath,
      collectionPath,
      viewName,
      includeNested,
      projectPath,
    })
      .then((nextEntries) => {
        if (!cancelled) setEntries(nextEntries);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Failed to load view entries:", error);
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

  return entries;
}
