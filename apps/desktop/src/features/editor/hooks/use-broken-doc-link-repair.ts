import { useCallback, useEffect, useState } from "react";

import {
  makeRelativeDocUrl,
  resolveDocLink,
  suggestLinkFix,
  type DocLinkResolveResult,
  type LinkFixSuggestion,
} from "../api/doc-link-api";
import { joinAbs } from "../lib/doc-link-utils";

interface UseBrokenDocLinkRepairInput {
  projectPath: string;
  sourcePath: string;
  sourceSpaceId: string | null;
  url: string;
}

export function useBrokenDocLinkRepair({
  projectPath,
  sourcePath,
  sourceSpaceId,
  url,
}: UseBrokenDocLinkRepairInput): {
  makeSuggestionUrl: (
    path: string,
    sourceSpacePath: string,
  ) => Promise<string | null>;
  resolved: DocLinkResolveResult | null;
  suggestions: LinkFixSuggestion[];
} {
  const [resolved, setResolved] = useState<DocLinkResolveResult | null>(null);
  const [suggestions, setSuggestions] = useState<LinkFixSuggestion[]>([]);

  useEffect(() => {
    let cancelled = false;

    resolveDocLink({
      projectPath,
      sourceSpaceId,
      sourcePath,
      url,
    })
      .then((next) => {
        if (cancelled) return [];
        setResolved(next);
        if (!next.targetPath) return [];
        return suggestLinkFix({
          projectPath,
          targetSpaceId: next.targetSpaceId,
          brokenPath: next.targetPath,
        });
      })
      .then((next) => {
        if (!cancelled && next) setSuggestions(next.slice(0, 3));
      })
      .catch((err) => {
        console.error("suggest_link_fix failed:", err);
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
      return makeRelativeDocUrl(sourceAbs, targetAbs);
    },
    [projectPath, sourcePath, targetSpacePath],
  );

  return { makeSuggestionUrl, resolved, suggestions };
}
