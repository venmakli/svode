import { useCallback, useEffect, useRef, useState } from "react";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PlateDocumentEditor } from "@/features/editor";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  deletePage as deletePageApi,
  duplicatePage as duplicatePageApi,
  getPageDetailState,
  readPage,
} from "../page-api";
import { isPageTreeMetaField, usePageFieldSave } from "../field-save";
import {
  useOpenPage,
  usePageTitleOutcomeEffect,
  useRetargetPage,
} from "../navigation";
import {
  applyPageTitleOutcome,
  type Page,
  type PageCover,
  type PageDetailState,
} from "../model";
import { PropertyPanel } from "@/features/properties/panel";
import { normalizeSchema } from "@/features/properties";
import { type PageSchemaResult } from "@/features/properties";
import { getPageSchema } from "@/features/properties/api";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useSpaceTreeSync } from "@/features/space";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { PageDeleteDialog } from "./page-delete-dialog";
import { PageDetailActions } from "./page-detail-actions";
import {
  PageIdentityHeader,
  PageIdentityHeaderSkeleton,
} from "./page-identity-header";
import { PageSystemFields } from "./page-system-fields";
import { handleError } from "../lib/errors";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import { propertyFieldSavePolicy } from "../property-field-save";
import { usePageName } from "../hooks/use-page-name";
import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { PageAccessRecovery } from "./page-access-recovery";
import { usePageOwnerSurfaceContribution } from "../hooks/page-owner-surface-context";
import { pageAttachmentOwnerPath } from "../model/page-attachments";
import * as m from "@/paraglide/messages.js";
import { PageOwnerTabs } from "./page-owner-tabs";

interface PageScreenProps {
  spacePath: string;
  projectPath?: string | null;
  pagePath: string;
  spaceId: string;
}

function getPageTargetKey(spacePath: string, pagePath: string) {
  return `${spacePath}\0${pagePath}`;
}

export function PageScreen({
  spacePath,
  projectPath,
  pagePath,
  spaceId,
}: PageScreenProps) {
  const pageSurface = usePageSurfaceSession();
  const pageOwnerSurface = usePageOwnerSurfaceContribution();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openPage(path, targetSpaceId ?? spaceId),
    [openPage, spaceId],
  );
  const retargetPage = useRetargetPage();
  const patchPageTreeMeta = useSpaceTreeSync(
    (state) => state.patchPageTreeMeta,
  );
  const reloadTreePathParent = useSpaceTreeSync(
    (state) => state.reloadTreePathParent,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const removeTreePath = useSpaceTreeSync((state) => state.removeTreePath);
  const pageTargetKey = getPageTargetKey(spacePath, pagePath);
  const [page, setPage] = useState<Page | null>(null);
  const [loadedPageKey, setLoadedPageKey] = useState<string | null>(null);
  const [schemaResult, setSchemaResult] = useState<PageSchemaResult | null>(
    null,
  );
  const [detailState, setDetailState] = useState<PageDetailState | null>(null);
  const [deletePage, setDeletePage] = useState<Page | null>(null);
  const [pathHandoff, setPathHandoff] = useState<{
    previousPath: string;
    path: string;
  } | null>(null);
  const reloadSeqRef = useRef(0);
  const adoptedPageTargetKeyRef = useRef<string | null>(null);
  const applyPageUpdate = useCallback(
    (pagePath: string, update: (page: Page) => Page) => {
      setPage((current) =>
        current && current.path === pagePath ? update(current) : current,
      );
    },
    [],
  );
  const renderedPageTargetKey =
    adoptedPageTargetKeyRef.current ?? pageTargetKey;
  const currentPage = loadedPageKey === renderedPageTargetKey ? page : null;
  const pageName = usePageName({
    pagePath,
    page: currentPage,
    spaceId,
  });
  const { flush: flushMetadata, save: updateField } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      if (isPageTreeMetaField(context.field)) {
        patchPageTreeMeta(
          spaceId,
          context.previousPage.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
        if (updated.path !== context.previousPage.path) {
          void reloadTreePathParents(spaceId, [
            context.previousPage.path,
            updated.path,
          ]);
        } else {
          void reloadTreePathParent(spaceId, updated.path);
        }
      }
      if (context.field === "title") pageName.clearSavedConflict();
    },
    onError: (error, context) => {
      if (context.field !== "title") return;
      pageName.handleSaveError(error);
    },
    recoverFromError: (saveError, _context, retry) =>
      pageSurface.recoverWriteError(saveError, retry),
  });

  useEffect(
    () => pageSurface.registerPersistence("metadata", flushMetadata),
    [flushMetadata, pageSurface],
  );

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

  usePageTitleOutcomeEffect({
    scopePath: spacePath,
    path: page?.path ?? pagePath,
    onOutcome: (titleOutcome) => {
      const nextTargetKey = getPageTargetKey(spacePath, titleOutcome.page.path);
      adoptedPageTargetKeyRef.current = nextTargetKey;
      setPage((current) =>
        current ? applyPageTitleOutcome(current, titleOutcome.page) : current,
      );
      setLoadedPageKey(nextTargetKey);
      if (titleOutcome.previousPath !== titleOutcome.page.path) {
        setPathHandoff({
          previousPath: titleOutcome.previousPath,
          path: titleOutcome.page.path,
        });
        retargetPage(
          titleOutcome.previousPath,
          titleOutcome.page.path,
          spaceId,
        );
      }
    },
  });

  const reload = useCallback(async () => {
    const sequence = reloadSeqRef.current + 1;
    reloadSeqRef.current = sequence;
    const targetKey = pageTargetKey;
    const startedAt = nowMs();
    let status: "ok" | "error" = "ok";
    setPage(null);
    setLoadedPageKey(null);
    setSchemaResult(null);
    setDetailState(null);
    try {
      const [nextPage, nextSchemaResult, nextDetailState] = await Promise.all([
        readPage({ spacePath, path: pagePath }),
        getPageSchema({ spacePath, filePath: pagePath }).catch(() => null),
        getPageDetailState({
          spacePath,
          path: pagePath,
        }).catch(() => null),
      ]);
      if (sequence !== reloadSeqRef.current) return;
      setPage(nextPage);
      setLoadedPageKey(targetKey);
      setSchemaResult(
        nextSchemaResult
          ? {
              ...nextSchemaResult,
              schema: normalizeSchema(nextSchemaResult.schema),
            }
          : null,
      );
      setDetailState(nextDetailState);
    } catch (error) {
      if (sequence !== reloadSeqRef.current) return;
      status = "error";
      if (
        pagePath.toLowerCase() === "readme.md" &&
        isFileNotFoundError(error, pagePath)
      ) {
        openScopeOwner({ kind: "space", spaceId });
        return;
      }
      throw error;
    } finally {
      logTiming("doc.open.detail", startedAt, {
        spaceId,
        status,
      });
    }
  }, [openScopeOwner, pagePath, pageTargetKey, spaceId, spacePath]);

  useEffect(() => {
    if (adoptedPageTargetKeyRef.current === pageTargetKey) {
      adoptedPageTargetKeyRef.current = null;
      return () => {
        reloadSeqRef.current += 1;
      };
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void reload().catch(handleError);
    });
    return () => {
      cancelled = true;
    };
  }, [pageTargetKey, reload]);

  async function updateCover(cover: PageCover | null) {
    if (!currentPage || pageSurface.readOnly) return;
    await updateField(currentPage, "cover", cover);
  }

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

  const handleManagedDocumentPathChange = useCallback(
    (path: string) => {
      const previousPath = page?.path ?? pagePath;
      adoptedPageTargetKeyRef.current = getPageTargetKey(spacePath, path);
      setPathHandoff({ path, previousPath });
      setPage((current) => (current ? { ...current, path } : current));
      setLoadedPageKey(getPageTargetKey(spacePath, path));
      setDetailState((current) => ({
        form: "folder",
        otherFileCount: (current?.otherFileCount ?? 0) + 1,
        subpageCount: current?.subpageCount ?? 0,
      }));
      retargetPage(previousPath, path, spaceId);
    },
    [page?.path, pagePath, retargetPage, spaceId, spacePath],
  );

  if (!currentPage) {
    return <PageLoadingState />;
  }
  const activePage = currentPage;
  const attachmentOwnerPath = pageAttachmentOwnerPath(
    currentPage.path,
    detailState,
  );
  const showAttachments = Boolean(
    attachmentOwnerPath && projectPath && pageOwnerSurface,
  );

  function updateTitle(value: string) {
    if (pageSurface.readOnly) return;
    if (!pageName.acceptTitle(value)) return;
    void pageSurface
      .runMutation(async () => {
        await updateField(activePage, "title", value, { flush: true });
      })
      .catch((error) => {
        if (!pageName.handleSaveError(error)) handleError(error);
      });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <PageIdentityHeader
          title={currentPage.meta.title}
          icon={currentPage.meta.icon}
          description={currentPage.meta.description ?? ""}
          cover={currentPage.meta.cover ?? null}
          projectPath={projectPath ?? null}
          spacePath={spacePath}
          pagePath={currentPage.path}
          onTitleChange={updateTitle}
          titleError={pageName.titleError}
          onIconChange={(value) =>
            void updateField(currentPage, "icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField(currentPage, "description", value).catch(
              handleError,
            )
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          metadata={<PageSystemFields meta={currentPage.meta} />}
          coverSize="compact"
          readOnly={pageSurface.readOnly}
          actions={
            <PageDetailActions
              page={currentPage}
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              onConverted={(nextPage, nested) => {
                setPage(nextPage);
                setLoadedPageKey(getPageTargetKey(spacePath, nextPage.path));
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
              onDuplicatePage={(pageToDuplicate) =>
                duplicateCurrentPage(pageToDuplicate)
              }
              onDeletePage={setDeletePage}
              readOnly={pageSurface.readOnly}
              runMutation={pageSurface.runMutation}
            />
          }
        />
        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div className="max-w-5xl">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={currentPage.path}
              pageLabel={currentPage.meta.title}
              schemaResult={schemaResult}
              values={currentPage.meta.extra ?? {}}
              mode="full"
              readOnly={pageSurface.readOnly}
              onOpenPath={openPath}
              onSchemaChange={setSchemaResult}
              onValueChange={async (field, value) => {
                const column = schemaResult.schema.columns.find(
                  (item) => item.name === field,
                );
                await updateField(currentPage, field, value, {
                  policy: column ? propertyFieldSavePolicy(column) : undefined,
                });
              }}
            />
          </div>
        ) : null}
      </div>
      {showAttachments ? (
        <PageOwnerTabs
          prepareForPageDeactivation={pageSurface.prepareForNavigation}
          page={
            <PageBody
              currentPage={currentPage}
              pathHandoff={pathHandoff}
              projectPath={projectPath}
              readOnly={pageSurface.readOnly}
              registerPersistence={pageSurface.registerPersistence}
              recoverWriteError={pageSurface.recoverWriteError}
              spaceId={spaceId}
              spacePath={spacePath}
              prepareManagedImport={pageSurface.prepareForNavigation}
              onDocumentPathChange={handleManagedDocumentPathChange}
            />
          }
          attachments={
            <>
              <PageAccessRecovery className="mx-auto w-full max-w-5xl px-6 pb-4" />
              {pageOwnerSurface?.renderAttachments({
                contentPath: currentPage.path,
                ownerPath: attachmentOwnerPath!,
                projectPath: projectPath!,
                readOnly: pageSurface.readOnly,
                spaceId,
                spacePath,
              })}
            </>
          }
        />
      ) : (
        <PageBody
          currentPage={currentPage}
          pathHandoff={pathHandoff}
          projectPath={projectPath}
          readOnly={pageSurface.readOnly}
          registerPersistence={pageSurface.registerPersistence}
          recoverWriteError={pageSurface.recoverWriteError}
          spaceId={spaceId}
          spacePath={spacePath}
          prepareManagedImport={pageSurface.prepareForNavigation}
          onDocumentPathChange={handleManagedDocumentPathChange}
        />
      )}
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
    </div>
  );
}

function PageBody({
  currentPage,
  pathHandoff,
  projectPath,
  readOnly,
  registerPersistence,
  recoverWriteError,
  spaceId,
  spacePath,
  prepareManagedImport,
  onDocumentPathChange,
}: {
  currentPage: Page;
  pathHandoff: { previousPath: string; path: string } | null;
  projectPath?: string | null;
  readOnly: boolean;
  registerPersistence: Parameters<
    typeof PlateDocumentEditor
  >[0]["registerPersistence"];
  recoverWriteError: Parameters<
    typeof PlateDocumentEditor
  >[0]["onWriteAccessError"];
  spaceId: string;
  spacePath: string;
  prepareManagedImport: () => Promise<boolean>;
  onDocumentPathChange(path: string): void;
}) {
  return (
    <>
      <PageAccessRecovery className="mx-auto w-full max-w-5xl px-6 pb-4" />
      <Separator />
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={currentPage.path}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={currentPage.meta}
        initialPage={currentPage}
        initialPageSpacePath={spacePath}
        documentPathHandoff={pathHandoff}
        readOnly={readOnly}
        registerPersistence={registerPersistence}
        onWriteAccessError={recoverWriteError}
        prepareManagedImport={async () => {
          if (!(await prepareManagedImport())) {
            throw new Error(m.page_surface_save_error());
          }
        }}
        onDocumentPathChange={onDocumentPathChange}
      />
    </>
  );
}

function isFileNotFoundError(error: unknown, path: string) {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return (
    message.toLowerCase().includes("file not found") &&
    message.toLowerCase().includes(path.toLowerCase())
  );
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
