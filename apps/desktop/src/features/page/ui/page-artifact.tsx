import { useCallback, useEffect, useRef, useState } from "react";
import { useCloseActiveContent, useOpenScopeOwner } from "@/features/artifact";
import {
  deletePage as deletePageApi,
  duplicatePage as duplicatePageApi,
} from "../page-api";
import { useOpenPage } from "../navigation";
import type { Page } from "../model";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { PinMenuItem } from "@/features/navigation";
import { pageNavigationItem } from "../lib/navigation-item";
import { logTiming, nowMs } from "@/shared/lib/performance";
import {
  PageDetailProvider,
  usePageDetailContext,
  type ReadmeStatus,
} from "../hooks/page-detail-context";
import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { handleError } from "../lib/errors";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import { isReadmeMissingError } from "../lib/readme-state";
import type { PageSurfaceLayout } from "../model/page-surface-layout";
import { PageDeleteDialog } from "./page-delete-dialog";
import { PageDetailActions } from "./page-detail-actions";
import { PageDetailHeader } from "./page-detail-header";
import { ReadmeSurface } from "./readme-surface";

interface PageArtifactProps {
  spacePath: string;
  projectPath?: string | null;
  pagePath: string;
  spaceId: string;
  fallbackTitle: string;
  renderSurface: (layout: PageSurfaceLayout) => React.ReactNode;
}

/** Full Page artifact: the shared Page detail runtime in the main content. */
export function PageArtifact({
  spacePath,
  projectPath,
  pagePath,
  spaceId,
  fallbackTitle,
  renderSurface,
}: PageArtifactProps) {
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const closeActiveContent = useCloseActiveContent();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openPage(path, targetSpaceId ?? spaceId),
    [openPage, spaceId],
  );
  const closeGonePage = useCallback(() => {
    if (pagePath.toLowerCase() === "readme.md")
      openScopeOwner({ kind: "space", spaceId });
    else closeActiveContent();
  }, [closeActiveContent, openScopeOwner, pagePath, spaceId]);
  return (
    <PageDetailProvider
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
      readmePath={pagePath}
      ownerPath={pagePath.replace(/\/readme\.md$/i, "")}
      target="page"
      fallbackTitle={fallbackTitle}
      onOpenPath={openPath}
      onPageGone={closeGonePage}
    >
      <PageArtifactContent
        spacePath={spacePath}
        projectPath={projectPath}
        pagePath={pagePath}
        spaceId={spaceId}
        renderSurface={renderSurface}
      />
    </PageDetailProvider>
  );
}

function PageArtifactContent({
  spacePath,
  projectPath,
  pagePath,
  spaceId,
  renderSurface,
}: Omit<PageArtifactProps, "fallbackTitle">) {
  const detail = usePageDetailContext();
  const pageSurface = usePageSurfaceSession();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const reloadTreePathParent = useSpaceTreeSync(
    (state) => state.reloadTreePathParent,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const removeTreePath = useSpaceTreeSync((state) => state.removeTreePath);
  const activeRootId = useSpace((state) => state.activeRootId);
  const [deletePage, setDeletePage] = useState<Page | null>(null);
  const page = detail.page;
  usePageOpenTiming(detail.status, spaceId);

  const rootReadmeMissing =
    detail.status === "error" &&
    pagePath.toLowerCase() === "readme.md" &&
    isReadmeMissingError(detail.error, pagePath);
  useEffect(() => {
    if (rootReadmeMissing) openScopeOwner({ kind: "space", spaceId });
  }, [openScopeOwner, rootReadmeMissing, spaceId]);

  useEffect(() => {
    if (!pageSurface.readOnly || !deletePage) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDeletePage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [deletePage, pageSurface.readOnly]);

  async function deleteCurrentPage(pageToDelete: Page) {
    await deletePageApi({
      spacePath,
      path: pageToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeletePage(null);
    removeTreePath(spaceId, pageToDelete.path);
    await reloadTreePathParent(spaceId, pageToDelete.path);
  }

  async function duplicateCurrentPage(pageToDuplicate: Page) {
    const duplicated = await duplicatePageApi({
      spacePath,
      filePath: pageToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(duplicated.warnings);
    await reloadTreePathParent(spaceId, duplicated.path);
    openPage(duplicated.path, spaceId);
  }

  const actions = page ? (
    <PageDetailActions
      page={page}
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
      onConverted={(nextPage, nested) => {
        if (nested) {
          openScopeOwner({
            kind: "collection",
            path: nextPage.path,
            spaceId,
          });
          void reloadTreePathParents(spaceId, [nextPage.path]);
        } else {
          openPage(nextPage.path, spaceId);
        }
      }}
      onDuplicatePage={duplicateCurrentPage}
      onDeletePage={setDeletePage}
      actionItemsBeforeDuplicate={
        <PinMenuItem item={pageNavigationItem(page, spaceId, activeRootId)} />
      }
      readOnly={pageSurface.readOnly}
      runMutation={pageSurface.runMutation}
    />
  ) : null;

  return (
    <>
      {renderSurface({
        header: (activeSurfaceId) => (
          <PageDetailHeader
            readOnly={pageSurface.readOnly}
            showReadError={activeSurfaceId !== "readme"}
            actions={actions}
          />
        ),
        children: <ReadmeSurface />,
      })}
      <PageDeleteDialog
        page={pageSurface.readOnly ? null : deletePage}
        onOpenChange={(open) => {
          if (!open) setDeletePage(null);
        }}
        onDeletePage={(pageToDelete) =>
          void pageSurface
            .runMutation(() => deleteCurrentPage(pageToDelete))
            .catch(handleError)
        }
      />
    </>
  );
}

function usePageOpenTiming(status: ReadmeStatus, spaceId: string) {
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (status === "loading") {
      startedAtRef.current = nowMs();
      return;
    }
    if (startedAtRef.current === null) return;
    logTiming("doc.open.detail", startedAtRef.current, {
      spaceId,
      status: status === "ready" ? "ok" : "error",
    });
    startedAtRef.current = null;
  }, [spaceId, status]);
}
