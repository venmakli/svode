import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EntryIdentityHeader } from "@/features/editor";
import { PlateDocumentEditor } from "@/features/editor";
import {
  deleteEntry as deleteEntryApi,
  duplicateEntry as duplicateEntryApi,
  readEntry,
} from "@/features/entry/api";
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
} from "@/features/entry/field-save";
import { useEntrySelectionStore } from "@/features/entry/selection";
import type { Entry, EntryCover } from "@/features/entry";
import { PropertyPanel } from "@/features/properties/panel";
import { normalizeSchema } from "@/features/properties";
import {
  type EntrySchemaResult,
} from "@/features/properties";
import { propertyFieldSavePolicy } from "@/features/properties/entry-save-policy";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useSpaceTreeSync } from "@/features/space";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { DeleteDialogs } from "./delete-dialogs";
import {
  EntryDetailActions,
  type EntryDetailState,
} from "./entry-detail-actions";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";
import { handleError } from "../lib/errors";

interface EntryDocumentScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
}

function getDocumentTargetKey(spacePath: string, documentPath: string) {
  return `${spacePath}\0${documentPath}`;
}

export function EntryDocumentScreen({
  spacePath,
  projectPath,
  documentPath,
  spaceId,
}: EntryDocumentScreenProps) {
  const openDocument = useEntrySelectionStore((state) => state.openDocument);
  const openPath = useCallback(
    (path: string) => openDocument(path, spaceId),
    [openDocument, spaceId],
  );
  const openScopeHome = useEntrySelectionStore((state) => state.openScopeHome);
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
  const reloadSeqRef = useRef(0);
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntry((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const updateField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          updated.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
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
        invoke<EntrySchemaResult | null>("get_entry_schema", {
          space: spacePath,
          filePath: documentPath,
        }).catch(() => null),
        invoke<EntryDetailState>("get_entry_detail_state", {
          space: spacePath,
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
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void reload().catch(handleError);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const currentEntry = loadedEntryKey === documentTargetKey ? entry : null;

  async function updateCover(cover: EntryCover | null) {
    if (!currentEntry) return;
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
    await reloadTreePathParent(spaceId, duplicated.path);
    openDocument(duplicated.path, spaceId);
  }

  if (!currentEntry) {
    return <EntryDocumentLoadingState />;
  }

  const showSubpages = detailState?.form === "folder";

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
          onTitleChange={(value) =>
            void updateField(currentEntry, "title", value).catch(handleError)
          }
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
          actions={
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
                openDocument(nextEntry.path, spaceId);
                if (nested)
                  void reloadTreePathParents(spaceId, [nextEntry.path]);
              }}
              onDuplicateEntry={(entryToDuplicate) =>
                void duplicateCurrentEntry(entryToDuplicate).catch(handleError)
              }
              onDeleteEntry={setDeleteEntry}
            />
          }
        />
        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div className="max-w-5xl">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={currentEntry.path}
              schemaResult={schemaResult}
              values={currentEntry.meta.extra ?? {}}
              mode="full"
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
        onDocumentPathChange={(path) => {
          setEntry((current) => (current ? { ...current, path } : current));
          setLoadedEntryKey(getDocumentTargetKey(spacePath, path));
          openDocument(path, spaceId);
        }}
      />
      {showSubpages ? (
        <EntrySubpages
          spacePath={spacePath}
          projectPath={projectPath}
          spaceId={spaceId}
          documentPath={currentEntry.path}
        />
      ) : null}
      <DeleteDialogs
        viewOpen={false}
        entry={deleteEntry}
        onViewOpenChange={() => undefined}
        onEntryOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        onDeleteView={() => undefined}
        onDeleteEntry={(entryToDelete) =>
          void deleteCurrentEntry(entryToDelete).catch(handleError)
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

function EntryDocumentLoadingState() {
  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <div className="flex max-w-5xl flex-col gap-4">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
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
