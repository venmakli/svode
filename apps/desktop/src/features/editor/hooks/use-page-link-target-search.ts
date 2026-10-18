import { useEffect, useMemo, useState } from "react";

import type { SearchItem } from "@/features/search";
import type { TreeNode } from "@/features/space";

import { searchPageLinkTargets } from "../api/page-link-api";

export interface LocalPageLinkSpace {
  spaceId: string;
  spacePath: string;
  spaceName: string;
  tree: TreeNode[];
}

interface UsePageLinkTargetSearchInput {
  debounceMs?: number;
  localCurrentSpace: LocalPageLinkSpace | null;
  projectPath: string | null;
  query: string;
  sourceSpaceId: string | null;
}

export function usePageLinkTargetSearch({
  debounceMs = 150,
  localCurrentSpace,
  projectPath,
  query,
  sourceSpaceId,
}: UsePageLinkTargetSearchInput): {
  items: SearchItem[];
  loading: boolean;
} {
  const request = useMemo(
    () =>
      projectPath
        ? { localCurrentSpace, projectPath, query, sourceSpaceId }
        : null,
    [localCurrentSpace, projectPath, query, sourceSpaceId],
  );
  // Items keep the request they answer: items for older input mean loading.
  const [result, setResult] = useState<{
    request: typeof request;
    items: SearchItem[];
  }>({ request: null, items: [] });

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchPageLinkTargets(
        request.projectPath,
        request.sourceSpaceId,
        request.query,
        request.localCurrentSpace,
      )
        .catch((err) => {
          console.error("doc link search failed:", err);
          return [];
        })
        .then((items) => {
          if (!cancelled) setResult({ request, items });
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [debounceMs, request]);

  if (!request) return { items: [], loading: false };
  return { items: result.items, loading: result.request !== request };
}
