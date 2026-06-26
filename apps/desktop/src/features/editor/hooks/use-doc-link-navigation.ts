import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useOpenEntryDocument } from "@/features/entry/selection";
import { useSpace } from "@/features/space";

import {
  cloneMissingDocLinkSpace,
  resolveDocLink,
  type DocLinkResolveResult,
} from "../api/doc-link-api";
import { useEditorStore } from "../model";
import {
  absoluteDocumentPath,
  isDocLink,
  relativeDocumentPath,
  resolveRelativeDocPath,
} from "../lib/doc-link-utils";
import { useEditorDocumentContext } from "./use-resolved-asset-url";
import * as m from "@/paraglide/messages.js";

interface UseDocLinkNavigationResult {
  cloneTarget: DocLinkResolveResult | null;
  handleCloneMissing: () => Promise<void>;
  isBroken: boolean;
  isCloning: boolean;
  onCloneDialogOpenChange: (open: boolean) => void;
  openDocLink: () => Promise<void>;
  resolvedPath: string | undefined;
  tooltipPath: string | undefined;
}

export function useDocLinkNavigation(
  url: string | undefined,
): UseDocLinkNavigationResult {
  const openDocument = useOpenEntryDocument();
  const editorDocument = useEditorDocumentContext();
  const activeRootId = useSpace((s) => s.activeRootId);
  const activeSpaceId = useSpace((s) => s.activeSpaceId);
  const openSpace = useSpace((s) => s.openSpace);
  const clearActiveSpace = useSpace((s) => s.clearActiveSpace);
  const loadSpaces = useSpace((s) => s.loadSpaces);
  const brokenLinks = useEditorStore((s) => s.brokenLinks);
  const [cloneTarget, setCloneTarget] = useState<DocLinkResolveResult | null>(
    null,
  );
  const [isCloning, setIsCloning] = useState(false);

  const activeDocument = editorDocument?.documentPath ?? null;
  const activeRootPath = editorDocument?.projectPath ?? null;
  const currentSpacePath = editorDocument?.spacePath ?? "";
  const activeRel =
    activeDocument && currentSpacePath
      ? relativeDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const activeAbs =
    activeDocument && currentSpacePath
      ? absoluteDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const resolvedPath =
    activeRel && url ? resolveRelativeDocPath(activeRel, url) : url;
  const tooltipPath =
    activeAbs && url ? resolveRelativeDocPath(activeAbs, url) : resolvedPath;
  const sourceSpaceId = editorDocument?.sourceSpaceId ?? null;
  const isBroken =
    !!url &&
    isDocLink(url) &&
    (brokenLinks.has(url) ||
      (resolvedPath ? brokenLinks.has(resolvedPath) : false));

  const openResolvedLink = useCallback(
    async (resolved: DocLinkResolveResult) => {
      if (!resolved.targetPath) return;
      if (resolved.targetSpaceId === null) {
        clearActiveSpace();
        openDocument(resolved.targetPath, activeRootId ?? undefined, {
          reveal: true,
        });
        return;
      }
      if (resolved.targetSpaceId !== activeSpaceId) {
        await openSpace(resolved.targetSpaceId);
      }
      openDocument(resolved.targetPath, resolved.targetSpaceId, {
        reveal: true,
      });
    },
    [activeRootId, activeSpaceId, clearActiveSpace, openDocument, openSpace],
  );

  const openDocLink = useCallback(async () => {
    if (!url || !activeRel || !activeRootPath) {
      if (resolvedPath && !isBroken) {
        openDocument(resolvedPath, undefined, { reveal: true });
      }
      return;
    }

    try {
      const resolved = await resolveDocLink({
        projectPath: activeRootPath,
        sourceSpaceId,
        sourcePath: activeRel,
        url,
      });
      if (resolved.status === "ready" && resolved.exists) {
        await openResolvedLink(resolved);
      } else if (resolved.status === "missing") {
        setCloneTarget(resolved);
      } else if (resolved.status === "broken") {
        toast.error(m.doc_link_space_unavailable({ name: resolved.spaceName }));
      }
    } catch (err) {
      console.error("resolve_doc_link failed:", err);
      if (resolvedPath && !isBroken) {
        openDocument(resolvedPath, undefined, { reveal: true });
      }
    }
  }, [
    activeRel,
    activeRootPath,
    isBroken,
    openDocument,
    openResolvedLink,
    resolvedPath,
    sourceSpaceId,
    url,
  ]);

  const handleCloneMissing = useCallback(async () => {
    if (!cloneTarget?.targetSpaceId || !activeRootPath) return;
    setIsCloning(true);
    try {
      await cloneMissingDocLinkSpace({
        projectPath: activeRootPath,
        spaceId: cloneTarget.targetSpaceId,
      });
      await loadSpaces(activeRootPath);
      await openResolvedLink({ ...cloneTarget, status: "ready", exists: true });
      setCloneTarget(null);
    } catch (err) {
      console.error("clone_missing_space failed:", err);
      toast.error(m.doc_link_clone_missing_failed());
    } finally {
      setIsCloning(false);
    }
  }, [activeRootPath, cloneTarget, loadSpaces, openResolvedLink]);

  const onCloneDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isCloning) setCloneTarget(null);
    },
    [isCloning],
  );

  return {
    cloneTarget,
    handleCloneMissing,
    isBroken,
    isCloning,
    onCloneDialogOpenChange,
    openDocLink,
    resolvedPath,
    tooltipPath,
  };
}
