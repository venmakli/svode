import { useEffect, useState } from "react";

import {
  useOpenScopeOwner,
  type ArtifactOpenTarget,
} from "@/features/artifact";
import { htmlDocumentApp, isHtmlDocumentPath } from "@/features/document";

/**
 * A neutral opening of an HTML file of the project in the main area (Stage
 * 11 `06` H1, A3): a file of an App opens that App as the tree opens it, any
 * other HTML file the Document. True while the answer is pending, so the
 * Document is not shown, nor served, before it.
 */
export function useHtmlAppOpening(input: {
  requestKey: number | null;
  target: ArtifactOpenTarget | null;
  projectPath: string | null;
  spacePath: string | null;
  rootSpaceId: string | null;
}): boolean {
  const { requestKey, target, projectPath, spacePath, rootSpaceId } = input;
  const openScopeOwner = useOpenScopeOwner();
  const [documentKey, setDocumentKey] = useState<number | null>(null);
  const asks =
    requestKey !== null &&
    target !== null &&
    spacePath !== null &&
    target.sourceShape === "file" &&
    !target.semanticHint &&
    isHtmlDocumentPath(target.path);
  const spaceId = target?.spaceId ?? null;
  const path = target?.path ?? null;

  useEffect(() => {
    if (!asks || path === null || spacePath === null) return;
    let cancelled = false;
    void htmlDocumentApp({
      projectPath: projectPath ?? spacePath,
      spaceId: spaceId === rootSpaceId ? null : spaceId,
      path,
    })
      // The Document names a path it refuses.
      .catch(() => null)
      .then((app) => {
        if (cancelled) return;
        if (app === null) setDocumentKey(requestKey);
        else if (app.kind === "space")
          openScopeOwner({ kind: "space", spaceId });
        else openScopeOwner({ kind: "app-directory", path: app.path, spaceId });
      });
    return () => {
      cancelled = true;
    };
  }, [
    asks,
    openScopeOwner,
    path,
    projectPath,
    requestKey,
    rootSpaceId,
    spaceId,
    spacePath,
  ]);

  return asks && documentKey !== requestKey;
}
