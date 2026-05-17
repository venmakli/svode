import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Maximize2, MoreVertical, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { EntryIdentityHeader } from "@/features/editor/entry-identity-header";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import type { Entry, EntryCover } from "@/features/editor/types";
import { PropertyPanel } from "@/features/properties/ui";
import type { EntrySchemaResult } from "@/features/properties/model";
import { normalizeSchema } from "@/features/properties/lib";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";

export interface EntryPeekTarget {
  entry: Entry;
  nested: boolean;
}

interface EntryPeekSheetProps {
  target: EntryPeekTarget | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onOpenChange: (open: boolean) => void;
  onOpenFullPage: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  renderNested: (entry: Entry, actions: ReactNode) => ReactNode;
}

export function EntryPeekSheet({
  target,
  spacePath,
  projectPath,
  spaceId,
  onOpenChange,
  onOpenFullPage,
  onDuplicateEntry,
  onDeleteEntry,
  renderNested,
}: EntryPeekSheetProps) {
  const open = Boolean(target);
  const [entry, setEntry] = useState<Entry | null>(target?.entry ?? null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );

  useEffect(() => {
    if (!target) {
      setEntry(null);
      setSchemaResult(null);
      return;
    }

    setEntry(target.entry);
    setSchemaResult(null);

    if (target.nested) return;

    let cancelled = false;
    void Promise.all([
      invoke<Entry>("read_entry", {
        space: spacePath,
        path: target.entry.path,
      }),
      invoke<EntrySchemaResult | null>("get_entry_schema", {
        space: spacePath,
        filePath: target.entry.path,
      }).catch(() => null),
    ])
      .then(([nextEntry, nextSchemaResult]) => {
        if (cancelled) return;
        setEntry(nextEntry);
        setSchemaResult(
          nextSchemaResult
            ? {
                ...nextSchemaResult,
                schema: normalizeSchema(nextSchemaResult.schema),
              }
            : null,
        );
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [spacePath, target]);

  const contentClassName = useMemo(
    () =>
      cn(
        "gap-0 p-0 data-[side=right]:sm:max-w-none",
        "shadow-[-24px_0_60px_color-mix(in_oklch,black_20%,transparent)]",
      ),
    [],
  );

  const currentEntry = entry ?? target?.entry ?? null;
  const actions = currentEntry ? (
    <EntryPeekActions
      entry={currentEntry}
      onOpenFullPage={onOpenFullPage}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
    />
  ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className={contentClassName}
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
      >
        <SheetTitle className="sr-only">
          {currentEntry?.meta.title ?? m.collection_open_in_peek()}
        </SheetTitle>

        {target?.nested && currentEntry ? (
          <div className="min-h-0 flex-1">
            {renderNested(currentEntry, actions)}
          </div>
        ) : currentEntry ? (
          <StandardEntryPeek
            entry={currentEntry}
            schemaResult={schemaResult}
            spacePath={spacePath}
            projectPath={projectPath}
            spaceId={spaceId}
            actions={actions}
            onEntryChange={setEntry}
            onSchemaChange={setSchemaResult}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function StandardEntryPeek({
  entry,
  schemaResult,
  spacePath,
  projectPath,
  spaceId,
  actions,
  onEntryChange,
  onSchemaChange,
}: {
  entry: Entry;
  schemaResult: EntrySchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  actions: ReactNode;
  onEntryChange: (entry: Entry) => void;
  onSchemaChange: (result: EntrySchemaResult | null) => void;
}) {
  async function updateField(field: string, value: unknown) {
    const updated = await invoke<Entry>("update_entry_field", {
      space: spacePath,
      filePath: entry.path,
      field,
      value,
      projectPath: projectPath ?? null,
    });
    onEntryChange(updated);
  }

  async function updateCover(cover: EntryCover | null) {
    await updateField("cover", cover);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            void updateField("title", value).catch(handleError)
          }
          onIconChange={(value) =>
            void updateField("icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField("description", value).catch(handleError)
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          actions={actions}
          coverSize="compact"
        />

        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div className="mt-4">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              filePath={entry.path}
              metaId={entry.meta.id}
              schemaResult={schemaResult}
              values={entry.meta.extra ?? {}}
              mode="full"
              onSchemaChange={onSchemaChange}
              onValueChange={async (field, value) => {
                await updateField(field, value);
              }}
            />
          </div>
        ) : null}
      </div>
      <Separator />
      <div className="min-h-0 flex-1">
        <PlateDocumentEditor
          bodyOnly
          documentPath={entry.path}
          documentSpaceId={spaceId}
          spacePath={spacePath}
          projectPath={projectPath}
          bodyOnlyMeta={entry.meta}
          onDocumentPathChange={(path) => {
            onEntryChange({ ...entry, path });
          }}
        />
      </div>
    </div>
  );
}

function EntryPeekActions({
  entry,
  onOpenFullPage,
  onDuplicateEntry,
  onDeleteEntry,
}: {
  entry: Entry;
  onOpenFullPage: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onOpenFullPage(entry)}
      >
        <Maximize2 data-icon="inline-start" />
        Full page
      </Button>
      <SheetClose asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <X />
          <span className="sr-only">{m.settings_cancel()}</span>
        </Button>
      </SheetClose>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreVertical />
            <span className="sr-only">{m.common_settings()}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => onDuplicateEntry(entry)}>
            <Copy data-icon="inline-start" />
            {m.collection_duplicate_entry()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDeleteEntry(entry)}
          >
            <Trash2 data-icon="inline-start" />
            {m.space_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
