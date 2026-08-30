import { useCallback, useEffect, useRef, useState } from "react";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PlateDocumentEditor } from "@/features/editor";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  deleteEntry as deleteEntryApi,
  duplicateEntry as duplicateEntryApi,
  getEntryDetailState,
  readEntry,
} from "../entry-api";
import { isEntryTreeMetaField, useEntryFieldSave } from "../field-save";
import {
  useOpenEntryDocument,
  useOpenEntryScopeHome,
  useEntryTitleOutcomeEffect,
  useRetargetEntryDocument,
} from "../selection";
import {
  applyEntryTitleOutcome,
  type Entry,
  type EntryCover,
  type EntryDetailState,
} from "../model";
import { PropertyPanel } from "@/features/properties/panel";
import { normalizeSchema } from "@/features/properties";
import { type EntrySchemaResult } from "@/features/properties";
import { getEntrySchema } from "@/features/properties/api";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useSpaceTreeSync } from "@/features/space";
import { RepositoryWorkStatus } from "@/features/git";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { EntryDeleteDialog } from "./entry-delete-dialog";
import { EntryDetailActions } from "./entry-detail-actions";
import {
  EntryIdentityHeader,
  EntryIdentityHeaderSkeleton,
} from "./entry-identity-header";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";
import { handleError } from "../lib/errors";
import { publishEntryFilenameWarnings } from "../lib/filename-warning";
import { propertyFieldSavePolicy } from "../property-field-save";
import { useEntryDocumentName } from "../hooks/use-entry-document-name";
import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { PageAccessRecovery } from "./page-access-recovery";

interface EntryDocumentScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}

function getDocumentTargetKey(spacePath: string, documentPath: string) {
  return `${spacePath}\0${documentPath}`;
}

export function EntryDocumentScreen({
  spacePath,
  projectPath,
  documentPath,
  spaceId,
  onOpenRepositorySettings,
}: EntryDocumentScreenProps) {
  const pageSurface = usePageSurfaceSession();
  const openDocument = useOpenEntryDocument();
  const openScopeOwner = useOpenScopeOwner();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openDocument(path, targetSpaceId ?? spaceId),
    [openDocument, spaceId],
  );
  const openScopeHome = useOpenEntryScopeHome();
  const retargetDocument = useRetargetEntryDocument();
  const patchEntryTreeMeta = useSpaceTreeSync(
    (state) => state.patchEntryTreeMeta,
  );
  const reloadTreePathParent = useSpaceTreeSync(
    (state) => state.reloadTreePathParent,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const removeTreePath = useSpaceTreeSync((state) => state.removeTreePath);
  const documentTargetKey = getDocumentTargetKey(spacePath, documentPath);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loadedEntryKey, setLoadedEntryKey] = useState<string | null>(null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );
  const [detailState, setDetailState] = useState<EntryDetailState | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [pathHandoff, setPathHandoff] = useState<{
    previousPath: string;
    path: string;
  } | null>(null);
  const reloadSeqRef = useRef(0);
  const adoptedDocumentTargetKeyRef = useRef<string | null>(null);
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntry((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const renderedDocumentTargetKey =
    adoptedDocumentTargetKeyRef.current ?? documentTargetKey;
  const currentEntry =
    loadedEntryKey === renderedDocumentTargetKey ? entry : null;
  const documentName = useEntryDocumentName({
    documentPath,
    entry: currentEntry,
    spaceId,
  });
  const { flush: flushMetadata, save: updateField } = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          context.previousEntry.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
        if (updated.path !== context.previousEntry.path) {
          void reloadTreePathParents(spaceId, [
            context.previousEntry.path,
            updated.path,
          ]);
        } else {
          void reloadTreePathParent(spaceId, updated.path);
        }
      }
      if (context.field === "title") documentName.clearSavedConflict();
    },
    onError: (error, context) => {
      if (context.field !== "title") return;
      documentName.handleSaveError(error);
    },
    recoverFromError: (saveError, _context, retry) =>
      pageSurface.recoverWriteError(saveError, retry),
  });

  useEffect(
    () => pageSurface.registerPersistence("metadata", flushMetadata),
    [flushMetadata, pageSurface],
  );

  useEffect(() => {
    if (!pageSurface.readOnly || !deleteEntry) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDeleteEntry(null);
    });
    return () => {
      cancelled = true;
    };
  }, [deleteEntry, pageSurface.readOnly]);

  useEntryTitleOutcomeEffect({
    scopePath: spacePath,
    path: entry?.path ?? documentPath,
    onOutcome: (titleOutcome) => {
      const nextTargetKey = getDocumentTargetKey(
        spacePath,
        titleOutcome.entry.path,
      );
      adoptedDocumentTargetKeyRef.current = nextTargetKey;
      setEntry((current) =>
        current ? applyEntryTitleOutcome(current, titleOutcome.entry) : current,
      );
      setLoadedEntryKey(nextTargetKey);
      if (titleOutcome.previousPath !== titleOutcome.entry.path) {
        setPathHandoff({
          previousPath: titleOutcome.previousPath,
          path: titleOutcome.entry.path,
        });
        retargetDocument(
          titleOutcome.previousPath,
          titleOutcome.entry.path,
          spaceId,
        );
      }
    },
  });

  const reload = useCallback(async () => {
    const sequence = reloadSeqRef.current + 1;
    reloadSeqRef.current = sequence;
    const targetKey = documentTargetKey;
    const startedAt = nowMs();
    let status: "ok" | "error" = "ok";
    setEntry(null);
    setLoadedEntryKey(null);
    setSchemaResult(null);
    setDetailState(null);
    try {
      const [nextEntry, nextSchemaResult, nextDetailState] = await Promise.all([
        readEntry({ spacePath, path: documentPath }),
        getEntrySchema({ spacePath, filePath: documentPath }).catch(() => null),
        getEntryDetailState({
          spacePath,
          path: documentPath,
        }).catch(() => null),
      ]);
      if (sequence !== reloadSeqRef.current) return;
      setEntry(nextEntry);
      setLoadedEntryKey(targetKey);
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
        documentPath.toLowerCase() === "readme.md" &&
        isFileNotFoundError(error, documentPath)
      ) {
        openScopeHome(spaceId);
        return;
      }
      throw error;
    } finally {
      logTiming("doc.open.detail", startedAt, {
        spaceId,
        status,
      });
    }
  }, [documentPath, documentTargetKey, openScopeHome, spaceId, spacePath]);

  useEffect(() => {
    if (adoptedDocumentTargetKeyRef.current === documentTargetKey) {
      adoptedDocumentTargetKeyRef.current = null;
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
  }, [documentTargetKey, reload]);

  async function updateCover(cover: EntryCover | null) {
    if (!currentEntry || pageSurface.readOnly) return;
    await updateField(currentEntry, "cover", cover);
  }

  async function deleteCurrentEntry(entryToDelete: Entry) {
    await deleteEntryApi({
      spacePath,
      path: entryToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeleteEntry(null);
    removeTreePath(spaceId, entryToDelete.path);
    await reloadTreePathParent(spaceId, entryToDelete.path);
  }

  async function duplicateCurrentEntry(entryToDuplicate: Entry) {
    const duplicated = await duplicateEntryApi({
      spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    publishEntryFilenameWarnings(duplicated.warnings);
    await reloadTreePathParent(spaceId, duplicated.path);
    openDocument(duplicated.path, spaceId);
  }

  if (!currentEntry) {
    return (
      <EntryDocumentLoadingState
        contextName={pageDisplayName(documentPath)}
        displayPath={documentPath}
        repositoryPath={spacePath}
        onOpenRepositorySettings={onOpenRepositorySettings}
      />
    );
  }
  const activeEntry = currentEntry;
  const showSubpages = detailState?.form === "folder";

  function updateTitle(value: string) {
    if (pageSurface.readOnly) return;
    if (!documentName.acceptTitle(value)) return;
    void pageSurface
      .runMutation(async () => {
        await updateField(activeEntry, "title", value, { flush: true });
      })
      .catch((error) => {
        if (!documentName.handleSaveError(error)) handleError(error);
      });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <EntryIdentityHeader
          title={currentEntry.meta.title}
          icon={currentEntry.meta.icon}
          description={currentEntry.meta.description ?? ""}
          cover={currentEntry.meta.cover ?? null}
          projectPath={projectPath ?? null}
          spacePath={spacePath}
          documentPath={currentEntry.path}
          onTitleChange={updateTitle}
          titleError={documentName.titleError}
          onIconChange={(value) =>
            void updateField(currentEntry, "icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField(currentEntry, "description", value).catch(
              handleError,
            )
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          metadata={<EntrySystemFields meta={currentEntry.meta} />}
          coverSize="compact"
          readOnly={pageSurface.readOnly}
          actions={
            <>
              <RepositoryWorkStatus
                contextName={currentEntry.meta.title}
                displayPath={currentEntry.path}
                repositoryPath={spacePath}
                onOpenRepositorySettings={onOpenRepositorySettings}
              />
              <EntryDetailActions
                entry={currentEntry}
                spacePath={spacePath}
                projectPath={projectPath}
                spaceId={spaceId}
                onConverted={(nextEntry, nested) => {
                  setEntry(nextEntry);
                  setLoadedEntryKey(
                    getDocumentTargetKey(spacePath, nextEntry.path),
                  );
                  if (nested) {
                    openScopeOwner({
                      kind: "collection",
                      path: nextEntry.path,
                      spaceId,
                    });
                    void reloadTreePathParents(spaceId, [nextEntry.path]);
                  } else {
                    openDocument(nextEntry.path, spaceId);
                  }
                }}
                onDuplicateEntry={(entryToDuplicate) =>
                  duplicateCurrentEntry(entryToDuplicate)
                }
                onDeleteEntry={setDeleteEntry}
                readOnly={pageSurface.readOnly}
                runMutation={pageSurface.runMutation}
              />
            </>
          }
        />
        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div className="max-w-5xl">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={currentEntry.path}
              entryLabel={currentEntry.meta.title}
              schemaResult={schemaResult}
              values={currentEntry.meta.extra ?? {}}
              mode="full"
              readOnly={pageSurface.readOnly}
              onOpenPath={openPath}
              onSchemaChange={setSchemaResult}
              onValueChange={async (field, value) => {
                const column = schemaResult.schema.columns.find(
                  (item) => item.name === field,
                );
                await updateField(currentEntry, field, value, {
                  policy: column ? propertyFieldSavePolicy(column) : undefined,
                });
              }}
            />
          </div>
        ) : null}
      </div>
      <PageAccessRecovery className="mx-auto w-full max-w-5xl px-6 pb-4" />
      <Separator />
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={currentEntry.path}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={currentEntry.meta}
        initialEntry={currentEntry}
        initialEntrySpacePath={spacePath}
        documentPathHandoff={pathHandoff}
        readOnly={pageSurface.readOnly}
        registerPersistence={pageSurface.registerPersistence}
        onWriteAccessError={pageSurface.recoverWriteError}
        onDocumentPathChange={(path) => {
          adoptedDocumentTargetKeyRef.current = getDocumentTargetKey(
            spacePath,
            path,
          );
          setEntry((current) => (current ? { ...current, path } : current));
          setLoadedEntryKey(getDocumentTargetKey(spacePath, path));
          retargetDocument(documentPath, path, spaceId);
        }}
      />
      {showSubpages ? (
        <EntrySubpages
          spacePath={spacePath}
          projectPath={projectPath}
          spaceId={spaceId}
          documentPath={currentEntry.path}
          readOnly={pageSurface.readOnly}
        />
      ) : null}
      <EntryDeleteDialog
        entry={pageSurface.readOnly ? null : deleteEntry}
        onOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        onDeleteEntry={(entryToDelete) =>
          void pageSurface
            .runMutation(() => deleteCurrentEntry(entryToDelete))
            .catch(handleError)
        }
      />
    </div>
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

function EntryDocumentLoadingState({
  contextName,
  displayPath,
  repositoryPath,
  onOpenRepositorySettings,
}: {
  contextName: string;
  displayPath: string;
  repositoryPath: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <EntryIdentityHeaderSkeleton
          actions={
            <RepositoryWorkStatus
              contextName={contextName}
              displayPath={displayPath}
              repositoryPath={repositoryPath}
              onOpenRepositorySettings={onOpenRepositorySettings}
            />
          }
        />
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

function pageDisplayName(path: string) {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.at(-1) ?? path;
  return name.toLowerCase() === "readme.md"
    ? (segments.at(-2) ?? name)
    : name.replace(/\.md$/i, "");
}
