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
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
} from "../field-save";
import { propertyFieldSavePolicy } from "../property-field-save";
import type { Entry, EntryCover } from "../model";
import { handleError } from "../lib/errors";
import { EntryIdentityHeader } from "./entry-identity-header";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";

interface EntryPeekSurfaceProps {
  entry: Entry;
  schemaResult: EntrySchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  actions: ReactNode;
  metadataBefore?: ReactNode;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
  onSchemaChange: (result: EntrySchemaResult | null) => void;
}

export function EntryPeekSurface({
  entry,
  schemaResult,
  spacePath,
  projectPath,
  spaceId,
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
  });

  async function updateCover(cover: EntryCover | null) {
    await updateField(entry, "cover", cover);
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="shrink-0 px-6 py-5">
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
          <div className="mt-4">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={entry.path}
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
      />
    </div>
  );
}

function useEntryPeekFieldSave({
  spacePath,
  projectPath,
  spaceId,
  onEntryChange,
}: {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
}) {
  const patchEntryTreeMeta = useSpaceTreeSync(
    (state) => state.patchEntryTreeMeta,
  );
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      onEntryChange((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [onEntryChange],
  );

  return useEntryFieldSave({
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
}
