import { useCallback, useEffect, useRef, useState } from "react";
import { usePublishMainChangesTarget } from "@/features/changes";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useOpenScopeOwner,
  useActiveContentSelection,
} from "@/features/artifact";
import {
  deletePage as deletePageApi,
  duplicatePage as duplicatePageApi,
  getPageDetailState,
} from "../page-api";
import { useOpenPage } from "../navigation";
import type { Page, PageDetailState } from "../model";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useSpaceTreeSync } from "@/features/space";
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
import { pageAttachmentOwnerPath } from "../model/page-attachments";
import type { PageSurfaceLayout } from "../model/page-surface-layout";
import { PageDeleteDialog } from "./page-delete-dialog";
import { PageDetailActions } from "./page-detail-actions";
import { PageDetailHeader } from "./page-detail-header";
import { PageIdentityHeaderSkeleton } from "./page-identity-header";
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
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openPage(path, targetSpaceId ?? spaceId),
    [openPage, spaceId],
  );
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
  const { selection } = useActiveContentSelection();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const reloadTreePathParent = useSpaceTreeSync(
    (state) => state.reloadTreePathParent,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const removeTreePath = useSpaceTreeSync((state) => state.removeTreePath);
  const [deletePage, setDeletePage] = useState<Page | null>(null);
  const page = detail.page;
  const path = page?.path ?? pagePath;
  const detailState = usePageDetailState(spacePath, path);
  usePageOpenTiming(detail.status, spaceId);

  usePublishMainChangesTarget(
    page && detailState
      ? {
          kind: "page",
          projectPath,
          sessionKey:
            selection?.kind === "artifact"
              ? selection.request.sessionKey
              : undefined,
          sourceShape: detailState.form === "leaf" ? "file" : "directory",
          spacePath,
          path: page.path,
          name: page.meta.title,
        }
      : null,
  );

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

  if (detailState === undefined) return <PageLoadingState />;

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
      readOnly={pageSurface.readOnly}
      runMutation={pageSurface.runMutation}
    />
  ) : null;

  return (
    <>
      {renderSurface({
        contentPath: path,
        directoryPath: pageAttachmentOwnerPath(path, detailState),
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

/**
 * Leaf/folder form of the open Page; `undefined` until the first answer.
 * The previous answer stays while the Page path changes.
 */
function usePageDetailState(spacePath: string, path: string) {
  const [state, setState] = useState<{
    detail: PageDetailState | null;
  }>();
  useEffect(() => {
    let cancelled = false;
    void getPageDetailState({ spacePath, path })
      .catch(() => null)
      .then((detail) => {
        if (!cancelled) setState({ detail });
      });
    return () => {
      cancelled = true;
    };
  }, [path, spacePath]);
  return state === undefined ? undefined : state.detail;
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

function PageLoadingState() {
  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <PageIdentityHeaderSkeleton />
        <div className="flex max-w-5xl flex-col gap-4">
          <div className="flex gap-2">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        </div>
      </div>
      <Separator />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-8">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
}
