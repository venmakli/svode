import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Separator } from "@/components/ui/separator";
import { EntryIdentityHeader } from "@/features/editor/entry-identity-header";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import type { Entry, EntryCover } from "@/features/editor/types";
import { PropertyPanel } from "@/features/properties/ui";
import { normalizeSchema } from "@/features/properties/lib";
import type { EntrySchemaResult } from "@/features/properties/model";
import { useLayoutStore } from "@/stores/layout";
import { useSpaceStore } from "@/stores/space";
import { DeleteDialogs } from "./delete-dialogs";
import {
  EntryDetailActions,
  type EntryDetailState,
} from "./entry-detail-actions";
import { useDebouncedEntryFieldUpdate } from "./entry-detail-fields";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";
import { handleError } from "../lib/errors";

interface EntryDocumentScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
}

export function EntryDocumentScreen({
  spacePath,
  projectPath,
  documentPath,
  spaceId,
}: EntryDocumentScreenProps) {
  const openDocument = useLayoutStore((state) => state.openDocument);
  const updateNodeMeta = useSpaceStore((state) => state.updateNodeMeta);
  const refreshTree = useSpaceStore((state) => state.refreshTree);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );
  const [detailState, setDetailState] = useState<EntryDetailState | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const updateField = useDebouncedEntryFieldUpdate({
    spacePath,
    projectPath,
    setEntry,
    onSaved: (updated) => {
      updateNodeMeta(
        spaceId,
        updated.path,
        updated.meta.title,
        updated.meta.icon,
        updated.meta.description ?? null,
      );
    },
  });

  const reload = useCallback(async () => {
    const [nextEntry, nextSchemaResult, nextDetailState] = await Promise.all([
      invoke<Entry>("read_entry", { space: spacePath, path: documentPath }),
      invoke<EntrySchemaResult | null>("get_entry_schema", {
        space: spacePath,
        filePath: documentPath,
      }).catch(() => null),
      invoke<EntryDetailState>("get_entry_detail_state", {
        space: spacePath,
        path: documentPath,
      }).catch(() => null),
    ]);
    setEntry(nextEntry);
    setSchemaResult(
      nextSchemaResult
        ? {
            ...nextSchemaResult,
            schema: normalizeSchema(nextSchemaResult.schema),
          }
        : null,
    );
    setDetailState(nextDetailState);
  }, [documentPath, spacePath]);

  useEffect(() => {
    void reload().catch(handleError);
  }, [reload]);

  async function updateCover(cover: EntryCover | null) {
    if (!entry) return;
    await updateField(entry, "cover", cover);
  }

  async function deleteCurrentEntry(entryToDelete: Entry) {
    await invoke("delete_entry", {
      space: spacePath,
      path: entryToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeleteEntry(null);
    await refreshTree(spaceId);
  }

  async function duplicateCurrentEntry(entryToDuplicate: Entry) {
    const duplicated = await invoke<Entry>("duplicate_entry", {
      space: spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    await refreshTree(spaceId);
    openDocument(duplicated.path, spaceId);
  }

  if (!entry) {
    return <div className="min-h-full" />;
  }

  const showSubpages = detailState?.form === "folder";

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex shrink-0 flex-col gap-4 px-6 pb-3 pt-5">
        <EntryIdentityHeader
          title={entry.meta.title}
          icon={entry.meta.icon}
          description={entry.meta.description ?? ""}
          cover={entry.meta.cover ?? null}
          projectPath={projectPath ?? null}
          spacePath={spacePath}
          documentPath={entry.path}
          onTitleChange={(value) =>
            void updateField(entry, "title", value).catch(handleError)
          }
          onIconChange={(value) =>
            void updateField(entry, "icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField(entry, "description", value).catch(handleError)
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          metadata={<EntrySystemFields meta={entry.meta} />}
          coverSize="compact"
          actions={
            <EntryDetailActions
              entry={entry}
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              onConverted={(nextEntry, nested) => {
                setEntry(nextEntry);
                openDocument(nextEntry.path, spaceId);
                if (nested) void refreshTree(spaceId);
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
              filePath={entry.path}
              metaId={entry.meta.id}
              schemaResult={schemaResult}
              values={entry.meta.extra ?? {}}
              mode="full"
              onSchemaChange={setSchemaResult}
              onValueChange={async (field, value) => {
                await updateField(entry, field, value);
              }}
            />
          </div>
        ) : null}
      </div>
      <Separator />
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={entry.path}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={entry.meta}
        onDocumentPathChange={(path) => {
          setEntry((current) => (current ? { ...current, path } : current));
          openDocument(path, spaceId);
        }}
      />
      {showSubpages ? (
        <EntrySubpages
          spacePath={spacePath}
          projectPath={projectPath}
          spaceId={spaceId}
          documentPath={entry.path}
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
