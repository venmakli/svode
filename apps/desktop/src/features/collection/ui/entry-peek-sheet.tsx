import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { Maximize2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/shared/lib/utils";
import { EntryIdentityHeader } from "@/features/editor";
import { PlateDocumentEditor } from "@/features/editor";
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
  type Entry,
  type EntryCover,
} from "@/features/entry";
import { PropertyPanel } from "@/features/properties";
import {
  propertyFieldSavePolicy,
  type EntrySchemaResult,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { useSpaceStore } from "@/features/space/model";
import { EntryDetailActions } from "./entry-detail-actions";
import { EntrySubpages } from "./entry-subpages";
import { EntrySystemFields } from "./entry-system-fields";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";

export interface EntryPeekTarget {
  entry: Entry;
  nested: boolean;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
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
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (entry: Entry) => Promise<void>;
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
  onSetTemplateDefault,
  onDuplicateTemplate,
  renderNested,
}: EntryPeekSheetProps) {
  const open = Boolean(target);
  const [entry, setEntry] = useState<Entry | null>(target?.entry ?? null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!target) {
      queueMicrotask(() => {
        if (!cancelled) {
          setEntry(null);
          setSchemaResult(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setEntry(target.entry);
        setSchemaResult(null);
      }
    });

    if (target.nested) {
      return () => {
        cancelled = true;
      };
    }
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
        "gap-0 p-0 pt-5 data-[side=right]:sm:max-w-none",
        "shadow-[-24px_0_60px_color-mix(in_oklch,black_20%,transparent)]",
      ),
    [],
  );

  const currentEntry =
    target && entry?.path !== target.entry.path ? target.entry : entry;
  const actionMenu = currentEntry ? (
    <EntryPeekActions
      entry={currentEntry}
      onOpenFullPage={onOpenFullPage}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
      onConvertedEntry={onConvertedEntry}
      template={target?.template}
      onSetTemplateDefault={onSetTemplateDefault}
      onDuplicateTemplate={onDuplicateTemplate}
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
    />
  ) : null;
  const actions =
    target?.nested && target.template && actionMenu ? (
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{m.collection_template_badge()}</Badge>
        {actionMenu}
      </div>
    ) : (
      actionMenu
    );

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
              template={target?.template}
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
  template,
  onEntryChange,
  onSchemaChange,
}: {
  entry: Entry;
  schemaResult: EntrySchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  actions: ReactNode;
  template?: EntryPeekTarget["template"];
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
  onSchemaChange: (result: EntrySchemaResult | null) => void;
}) {
  const patchEntryTreeMeta = useSpaceStore((state) => state.patchEntryTreeMeta);
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      onEntryChange((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [onEntryChange],
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
              {template ? (
                <Badge variant="secondary">
                  {m.collection_template_badge()}
                </Badge>
              ) : null}
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

function EntryPeekActions({
  entry,
  onOpenFullPage,
  onDuplicateEntry,
  onDeleteEntry,
  onConvertedEntry,
  template,
  onSetTemplateDefault,
  onDuplicateTemplate,
  spacePath,
  projectPath,
  spaceId,
}: {
  entry: Entry;
  onOpenFullPage: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onConvertedEntry: (entry: Entry, nested: boolean) => void;
  template?: EntryPeekTarget["template"];
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (entry: Entry) => Promise<void>;
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
        template={template}
        onSetTemplateDefault={onSetTemplateDefault}
        onDuplicateTemplate={onDuplicateTemplate}
      />
    </div>
  );
}
