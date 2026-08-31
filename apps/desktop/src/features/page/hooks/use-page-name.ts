import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { useSpaceTreeSync } from "@/features/space";
import {
  pageNameConflictFromError,
  findPageNameConflictPath,
} from "../model/page-name";
import type { Page } from "../model/types";

export function usePageName({
  pagePath,
  page,
  spaceId,
}: {
  pagePath: string;
  page: Page | null;
  spaceId: string;
}) {
  const targetKey = `${spaceId}\0${pagePath}`;
  const [localConflict, setLocalConflict] = useState<{
    targetKey: string;
    path: string | null;
  } | null>(null);
  const localConflictPath =
    localConflict?.targetKey === targetKey ? localConflict.path : undefined;
  const siblingRows = useSpaceTreeSync((state) => {
    const path = pagePath.replace(/\\/g, "/");
    const parts = path.split("/");
    const isReadme = parts.at(-1)?.toLowerCase() === "readme.md";
    parts.pop();
    if (isReadme) parts.pop();
    return state.childrenByParentPath[spaceId]?.[parts.join("/")] ?? [];
  });

  const projectedConflictPath =
    page?.name_conflict?.conflicts[0]?.path ?? null;
  const effectiveConflictPath =
    localConflictPath === undefined ? projectedConflictPath : localConflictPath;
  const titleError = effectiveConflictPath
    ? localConflictPath === undefined
      ? m.editor_name_existing_conflict({ path: effectiveConflictPath })
      : m.page_name_conflict({ path: effectiveConflictPath })
    : null;

  function acceptTitle(title: string) {
    if (!page) return false;
    const conflictPath = findPageNameConflictPath(
      title,
      siblingRows,
      page.path,
    );
    if (conflictPath) {
      setLocalConflict({ path: conflictPath, targetKey });
      return false;
    }
    setLocalConflict({ path: null, targetKey });
    return true;
  }

  function handleSaveError(error: unknown) {
    const conflict = pageNameConflictFromError(error);
    if (!conflict) return false;
    setLocalConflict({
      path: conflict.conflicts[0]?.path ?? null,
      targetKey,
    });
    return true;
  }

  return {
    acceptTitle,
    clearSavedConflict: () => setLocalConflict({ path: null, targetKey }),
    handleSaveError,
    titleError,
  };
}
