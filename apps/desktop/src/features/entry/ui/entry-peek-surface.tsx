import {
  useCallback,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Separator } from "@/components/ui/separator";
import { PlateDocumentEditor } from "@/features/editor";
import { PropertyPanel } from "@/features/properties/panel";
import type { EntrySchemaResult } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { isEntryTreeMetaField, useEntryFieldSave } from "../field-save";
import { propertyFieldSavePolicy } from "../property-field-save";
import type { Entry, EntryCover } from "../model";
import { handleError } from "../lib/errors";
import { EntryIdentityHeader } from "./entry-identity-header";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";

interface EntryPeekSurfaceProps {
  readOnly?: boolean;
  entry: Entry;
  schemaResult: EntrySchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  documentPathHandoff?: { previousPath: string; path: string } | null;
  actions?: ReactNode;
  metadataBefore?: ReactNode;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
  onSchemaChange: (result: EntrySchemaResult | null) => void;
}

export function EntryPeekSurface({
  readOnly = false,
  entry,
  schemaResult,
  spacePath,
  projectPath,
  spaceId,
  documentPathHandoff = null,
  actions,
  metadataBefore,
  onOpenPath,
  onEntryChange,
  onSchemaChange,
}: EntryPeekSurfaceProps) {
  const updateField = useEntryPeekFieldSave({
    spacePath,
    projectPath,
    spaceId,
    onEntryChange,
    readOnly,
  });

  async function updateCover(cover: EntryCover | null) {
    await updateField(entry, "cover", cover);
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <EntryIdentityHeader
          readOnly={readOnly}
          title={entry.meta.title}
          icon={entry.meta.icon}
          description={entry.meta.description ?? ""}
          cover={entry.meta.cover ?? null}
          projectPath={projectPath ?? null}
          spacePath={spacePath}
          documentPath={entry.path}
          onTitleChange={(value) =>
            void updateField(entry, "title", value, { flush: true }).catch(
              handleError,
            )
          }
          onIconChange={(value) =>
            void updateField(entry, "icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField(entry, "description", value).catch(handleError)
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          actions={actions}
          metadata={
            <div className="flex flex-col items-end gap-1">
              {metadataBefore}
              <EntrySystemFields meta={entry.meta} />
            </div>
          }
          coverSize="compact"
        />

        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div>
            <PropertyPanel
              readOnly={readOnly}
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={entry.path}
              entryLabel={entry.meta.title}
              schemaResult={schemaResult}
              values={entry.meta.extra ?? {}}
              mode="peek"
              onOpenPath={onOpenPath}
              onSchemaChange={onSchemaChange}
              onValueChange={async (field, value) => {
                const column = schemaResult.schema.columns.find(
                  (item) => item.name === field,
                );
                await updateField(entry, field, value, {
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
        documentPath={entry.path}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={entry.meta}
        initialEntry={entry}
        initialEntrySpacePath={spacePath}
        documentPathHandoff={documentPathHandoff}
        readOnly={readOnly}
        onDocumentPathChange={(path) => {
          onEntryChange((current) =>
            current ? { ...current, path } : current,
          );
        }}
      />
      <EntrySubpages
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        documentPath={entry.path}
        readOnly={readOnly}
      />
    </div>
  );
}

function useEntryPeekFieldSave({
  spacePath,
  projectPath,
  spaceId,
  onEntryChange,
  readOnly,
}: {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
  readOnly: boolean;
}) {
  const patchEntryTreeMeta = useSpaceTreeSync(
    (state) => state.patchEntryTreeMeta,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      onEntryChange((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [onEntryChange],
  );

  const { save } = useEntryFieldSave({
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
        }
      }
    },
  });
  return useCallback(
    (...args: Parameters<typeof save>) => {
      if (readOnly) return Promise.resolve();
      return save(...args);
    },
    [readOnly, save],
  );
}
