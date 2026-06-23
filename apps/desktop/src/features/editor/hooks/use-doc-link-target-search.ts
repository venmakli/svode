import { useEffect, useState } from "react";

import type { SearchItem } from "@/features/search";
import type { TreeNode } from "@/features/space";

import { searchDocLinkTargets } from "../api/doc-link-api";

export interface LocalDocLinkSpace {
  spaceId: string;
  spacePath: string;
  spaceName: string;
  tree: TreeNode[];
}

interface UseDocLinkTargetSearchInput {
  debounceMs?: number;
  localCurrentSpace: LocalDocLinkSpace | null;
  projectPath: string | null;
  query: string;
  sourceSpaceId: string | null;
}

export function useDocLinkTargetSearch({
  debounceMs = 150,
  localCurrentSpace,
  projectPath,
  query,
  sourceSpaceId,
}: UseDocLinkTargetSearchInput): {
  items: SearchItem[];
  loading: boolean;
} {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectPath) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setItems([]);
          setLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });
    const timer = window.setTimeout(() => {
      searchDocLinkTargets(projectPath, sourceSpaceId, query, localCurrentSpace)
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch((err) => {
          console.error("doc link search failed:", err);
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [debounceMs, localCurrentSpace, projectPath, query, sourceSpaceId]);

  return { items, loading };
}
