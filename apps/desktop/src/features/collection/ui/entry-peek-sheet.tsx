import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { EntryDetailActions } from "./entry-detail-actions";
import { useDebouncedEntryFieldUpdate } from "./entry-detail-fields";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";
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
  onConvertedEntry: (entry: Entry, nested: boolean) => void;
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
  onConvertedEntry,
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
      onConvertedEntry={onConvertedEntry}
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
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
          <PeekScrollSurface>
            {renderNested(currentEntry, actions)}
          </PeekScrollSurface>
        ) : currentEntry ? (
          <PeekScrollSurface>
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
          </PeekScrollSurface>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PeekScrollSurface({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {children}
    </div>
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
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
  onSchemaChange: (result: EntrySchemaResult | null) => void;
}) {
  const updateField = useDebouncedEntryFieldUpdate({
    spacePath,
    projectPath,
    setEntry: onEntryChange,
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
          metadata={<EntrySystemFields meta={entry.meta} />}
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
              mode="peek"
              onSchemaChange={onSchemaChange}
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

function EntryPeekActions({
  entry,
  onOpenFullPage,
  onDuplicateEntry,
  onDeleteEntry,
  onConvertedEntry,
  spacePath,
  projectPath,
  spaceId,
}: {
  entry: Entry;
  onOpenFullPage: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onConvertedEntry: (entry: Entry, nested: boolean) => void;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
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
      <EntryDetailActions
        entry={entry}
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        onConverted={onConvertedEntry}
        onDuplicateEntry={onDuplicateEntry}
        onDeleteEntry={onDeleteEntry}
      />
    </div>
  );
}
