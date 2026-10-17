import { useEffect, useState } from "react";
import type { PageFolderContents } from "@/features/content-actions";
import { getPageDetailState } from "@/features/page/page-api";

/** What a folder-form Page holds besides its README, read once per mount. */
export function usePageFolderContents(
  spacePath: string | null,
  path: string | null,
): PageFolderContents | null {
  const [state, setState] = useState<{
    key: string;
    contents: PageFolderContents;
  } | null>(null);
  const key = spacePath && path ? `${spacePath}\n${path}` : null;

  useEffect(() => {
    if (!spacePath || !path || !key) return;
    let cancelled = false;
    void getPageDetailState({ spacePath, path })
      .then((detail) => {
        if (cancelled) return;
        setState({
          key,
          contents: {
            subpageCount: detail.subpageCount,
            otherFileCount: detail.otherFileCount,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, path, spacePath]);

  return state?.key === key ? state.contents : null;
}
