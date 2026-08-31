import { useCallback, useEffect, useState } from "react";

import {
  makeRelativePageUrl,
  resolvePageLink,
  suggestPageLinkFix,
  type PageLinkResolveResult,
  type PageLinkFixSuggestion,
} from "../api/page-link-api";
import { joinAbs } from "../lib/page-link-utils";

interface UseBrokenPageLinkRepairInput {
  projectPath: string;
  sourcePath: string;
  sourceSpaceId: string | null;
  url: string;
}

export function useBrokenPageLinkRepair({
  projectPath,
  sourcePath,
  sourceSpaceId,
  url,
}: UseBrokenPageLinkRepairInput): {
  makeSuggestionUrl: (
    path: string,
    sourceSpacePath: string,
  ) => Promise<string | null>;
  resolved: PageLinkResolveResult | null;
  suggestions: PageLinkFixSuggestion[];
} {
  const [resolved, setResolved] = useState<PageLinkResolveResult | null>(null);
  const [suggestions, setSuggestions] = useState<PageLinkFixSuggestion[]>([]);

  useEffect(() => {
    let cancelled = false;

    resolvePageLink({
      projectPath,
      sourceSpaceId,
      sourcePath,
      url,
    })
      .then((next) => {
        if (cancelled) return [];
        setResolved(next);
        if (!next.targetPath) return [];
        return suggestPageLinkFix({
          projectPath,
          targetSpaceId: next.targetSpaceId,
          brokenPath: next.targetPath,
        });
      })
      .then((next) => {
        if (!cancelled && next) setSuggestions(next.slice(0, 3));
      })
      .catch((err) => {
        console.error("Page link fix suggestion failed:", err);
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, sourcePath, sourceSpaceId, url]);

  const targetSpacePath = resolved?.targetSpacePath ?? null;
  const makeSuggestionUrl = useCallback(
    async (path: string, sourceSpacePath: string) => {
      if (!targetSpacePath) return null;
      const sourceAbs = joinAbs(sourceSpacePath || projectPath, sourcePath);
      const targetAbs = joinAbs(targetSpacePath, path);
      return makeRelativePageUrl(sourceAbs, targetAbs);
    },
    [projectPath, sourcePath, targetSpacePath],
  );

  return { makeSuggestionUrl, resolved, suggestions };
}
