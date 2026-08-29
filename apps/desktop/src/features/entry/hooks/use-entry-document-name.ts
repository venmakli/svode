import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { useSpaceTreeSync } from "@/features/space";
import {
  documentNameConflictFromError,
  findDocumentNameConflictPath,
} from "../model/document-name";
import type { Entry } from "../model/types";

export function useEntryDocumentName({
  documentPath,
  entry,
  spaceId,
}: {
  documentPath: string;
  entry: Entry | null;
  spaceId: string;
}) {
  const targetKey = `${spaceId}\0${documentPath}`;
  const [localConflict, setLocalConflict] = useState<{
    targetKey: string;
    path: string | null;
  } | null>(null);
  const localConflictPath =
    localConflict?.targetKey === targetKey ? localConflict.path : undefined;
  const siblingRows = useSpaceTreeSync((state) => {
    const path = documentPath.replace(/\\/g, "/");
    const parts = path.split("/");
    const isReadme = parts.at(-1)?.toLowerCase() === "readme.md";
    parts.pop();
    if (isReadme) parts.pop();
    return state.childrenByParentPath[spaceId]?.[parts.join("/")] ?? [];
  });

  const projectedConflictPath =
    entry?.name_conflict?.conflicts[0]?.path ?? null;
  const effectiveConflictPath =
    localConflictPath === undefined ? projectedConflictPath : localConflictPath;
  const titleError = effectiveConflictPath
    ? localConflictPath === undefined
      ? m.editor_name_existing_conflict({ path: effectiveConflictPath })
      : m.page_name_conflict({ path: effectiveConflictPath })
    : null;

  function acceptTitle(title: string) {
    if (!entry) return false;
    const conflictPath = findDocumentNameConflictPath(
      title,
      siblingRows,
      entry.path,
    );
    if (conflictPath) {
      setLocalConflict({ path: conflictPath, targetKey });
      return false;
    }
    setLocalConflict({ path: null, targetKey });
    return true;
  }

  function handleSaveError(error: unknown) {
    const conflict = documentNameConflictFromError(error);
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
