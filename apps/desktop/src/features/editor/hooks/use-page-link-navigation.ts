import { useCallback, useState } from "react";
import { usePluginOption } from "platejs/react";
import { toast } from "sonner";

import { useOpenArtifact } from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import { useSpace } from "@/features/space";

import {
  cloneMissingPageLinkSpace,
  resolvePageLink,
  type PageLinkResolveResult,
} from "../api/page-link-api";
import { BrokenLinksPlugin } from "../plate/broken-links-plugin";
import {
  absoluteDocumentPath,
  isBrokenPageLink,
  isPageLink,
  pageLinkPath,
  relativeDocumentPath,
  resolveRelativeDocPath,
} from "../lib/page-link-utils";
import { useEditorDocumentContext } from "./use-resolved-asset-url";
import * as m from "@/paraglide/messages.js";

/**
 * What a link of a Page opens: a Page, or any other file of the project,
 * which opens with the neutral opening of an artifact (DF-317).
 */
type PageLinkTargetKind = "page" | "file";

interface PageLinkCloneTarget {
  kind: PageLinkTargetKind;
  resolved: PageLinkResolveResult;
}

interface UsePageLinkOpenerResult {
  cloneTarget: PageLinkResolveResult | null;
  handleCloneMissing: () => Promise<void>;
  isCloning: boolean;
  onCloneDialogOpenChange: (open: boolean) => void;
  openLink: (url: string) => Promise<void>;
}

interface UsePageLinkNavigationResult extends Omit<
  UsePageLinkOpenerResult,
  "openLink"
> {
  isBroken: boolean;
  openLink: () => Promise<void>;
  resolvedPath: string | undefined;
  tooltipPath: string | undefined;
}

function sourceDocumentPaths(
  documentPath: string | null,
  spacePath: string,
): { rel: string | null; abs: string | null } {
  if (!documentPath || !spacePath) {
    return { rel: documentPath, abs: documentPath };
  }
  return {
    rel: relativeDocumentPath(documentPath, spacePath),
    abs: absoluteDocumentPath(documentPath, spacePath),
  };
}

function linkResolvedPath(url: string, sourceRel: string | null): string {
  return sourceRel ? resolveRelativeDocPath(sourceRel, url) : pageLinkPath(url);
}

/**
 * Opens a link of the Page in the editor: resolves it from the Page the way
 * `resolve_doc_link` does, switches to the target Space and opens a Page as a
 * Page and any other file with the neutral opening of an artifact. A missing
 * Space asks to clone it, a broken one tells so.
 */
export function usePageLinkOpener(): UsePageLinkOpenerResult {
  const openDocument = useOpenPage();
  const openArtifact = useOpenArtifact();
  const editorDocument = useEditorDocumentContext();
  const activeRootId = useSpace((s) => s.activeRootId);
  const activeSpaceId = useSpace((s) => s.activeSpaceId);
  const openSpace = useSpace((s) => s.openSpace);
  const clearActiveSpace = useSpace((s) => s.clearActiveSpace);
  const loadSpaces = useSpace((s) => s.loadSpaces);
  const brokenLinks = usePluginOption(BrokenLinksPlugin, "brokenLinks");
  const [cloneTarget, setCloneTarget] = useState<PageLinkCloneTarget | null>(
    null,
  );
  const [isCloning, setIsCloning] = useState(false);

  const activeRootPath = editorDocument?.projectPath ?? null;
  const sourceSpaceId = editorDocument?.sourceSpaceId ?? null;
  const source = sourceDocumentPaths(
    editorDocument?.documentPath ?? null,
    editorDocument?.spacePath ?? "",
  );
  const activeRel = source.rel;

  const openTarget = useCallback(
    (kind: PageLinkTargetKind, path: string, spaceId: string | undefined) => {
      if (kind === "page") {
        openDocument(path, spaceId, { reveal: true });
      } else {
        openArtifact({ path, spaceId, sourceShape: "file" }, { reveal: true });
      }
    },
    [openArtifact, openDocument],
  );

  const openResolvedLink = useCallback(
    async (kind: PageLinkTargetKind, resolved: PageLinkResolveResult) => {
      if (!resolved.targetPath) return;
      if (resolved.targetSpaceId === null) {
        clearActiveSpace();
        openTarget(kind, resolved.targetPath, activeRootId ?? undefined);
        return;
      }
      if (resolved.targetSpaceId !== activeSpaceId) {
        await openSpace(resolved.targetSpaceId);
      }
      openTarget(kind, resolved.targetPath, resolved.targetSpaceId);
    },
    [activeRootId, activeSpaceId, clearActiveSpace, openSpace, openTarget],
  );

  const openLink = useCallback(
    async (url: string) => {
      const kind: PageLinkTargetKind = isPageLink(url) ? "page" : "file";
      const resolvedPath = linkResolvedPath(url, activeRel);
      const isBroken = isBrokenPageLink(brokenLinks, url, activeRel);
      const openUnresolved = () => {
        if (resolvedPath && !isBroken) {
          openTarget(kind, resolvedPath, undefined);
        }
      };
      if (!activeRel || !activeRootPath) {
        openUnresolved();
        return;
      }

      try {
        const resolved = await resolvePageLink({
          projectPath: activeRootPath,
          sourceSpaceId,
          sourcePath: activeRel,
          url,
        });
        if (resolved.status === "ready") {
          // A missing file opens its viewer, which shows it is not found; a
          // missing Page stays broken.
          if (resolved.exists || kind === "file") {
            await openResolvedLink(kind, resolved);
          }
        } else if (resolved.status === "missing") {
          setCloneTarget({ kind, resolved });
        } else if (resolved.status === "broken") {
          // A file link outside the project opens nothing, as before.
          if (kind === "page" || resolved.targetSpaceId !== null) {
            toast.error(
              m.page_link_space_unavailable({ name: resolved.spaceName }),
            );
          }
        }
      } catch (err) {
        console.error("resolve_page_link failed:", err);
        openUnresolved();
      }
    },
    [
      activeRel,
      activeRootPath,
      brokenLinks,
      openResolvedLink,
      openTarget,
      sourceSpaceId,
    ],
  );

  const handleCloneMissing = useCallback(async () => {
    if (!cloneTarget?.resolved.targetSpaceId || !activeRootPath) return;
    setIsCloning(true);
    try {
      await cloneMissingPageLinkSpace({
        projectPath: activeRootPath,
        spaceId: cloneTarget.resolved.targetSpaceId,
      });
      await loadSpaces(activeRootPath);
      await openResolvedLink(cloneTarget.kind, {
        ...cloneTarget.resolved,
        status: "ready",
        exists: true,
      });
      setCloneTarget(null);
    } catch (err) {
      console.error("clone_missing_space failed:", err);
      toast.error(m.page_link_clone_missing_failed());
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
    cloneTarget: cloneTarget?.resolved ?? null,
    handleCloneMissing,
    isCloning,
    onCloneDialogOpenChange,
    openLink,
  };
}

export function usePageLinkNavigation(
  url: string | undefined,
): UsePageLinkNavigationResult {
  const opener = usePageLinkOpener();
  const editorDocument = useEditorDocumentContext();
  const brokenLinks = usePluginOption(BrokenLinksPlugin, "brokenLinks");
  const source = sourceDocumentPaths(
    editorDocument?.documentPath ?? null,
    editorDocument?.spacePath ?? "",
  );
  const resolvedPath = url ? linkResolvedPath(url, source.rel) : undefined;
  const tooltipPath =
    source.abs && url ? resolveRelativeDocPath(source.abs, url) : resolvedPath;
  const isBroken = isBrokenPageLink(brokenLinks, url, source.rel);
  const { openLink: openUrl } = opener;

  const openLink = useCallback(async () => {
    if (url) await openUrl(url);
  }, [openUrl, url]);

  return {
    ...opener,
    isBroken,
    openLink,
    resolvedPath,
    tooltipPath,
  };
}
