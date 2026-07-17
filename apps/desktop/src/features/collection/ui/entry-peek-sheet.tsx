import { useMemo, useState, type ReactNode } from "react";
import { Maximize2, Star, StarOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/shared/lib/utils";
import type { Entry } from "@/features/entry";
import { EntryDetailActions, EntryPeekSurface } from "@/features/entry/detail";
import { handleError } from "../hooks/error-feedback";
import { useEntryPeekLoader } from "../hooks";
import type {
  CollectionPeekSurfaceState,
  CollectionRouteState,
  EntryPeekTarget,
} from "../model";
import type { CalendarScope } from "../model/calendar-types";
import * as m from "@/paraglide/messages.js";

interface EntryPeekSheetProps {
  target: EntryPeekTarget | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onOpenChange: (open: boolean) => void;
  onOpenFullPage: (
    entry: Entry,
    spaceId?: string | null,
    viewName?: string | null,
    surfaceId?: CollectionPeekSurfaceState["surfaceId"],
  ) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onConvertedEntry: (entry: Entry, nested: boolean) => void;
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (entry: Entry) => Promise<void>;
  renderNested: (
    entry: Entry,
    actions: ReactNode,
    routeState: CollectionRouteState,
    surfaceState: CollectionPeekSurfaceState,
  ) => ReactNode;
}

export function EntryPeekSheet({
  target,
  spacePath,
  projectPath,
  spaceId,
  onOpenChange,
  onOpenFullPage,
  onOpenPath,
  onDuplicateEntry,
  onDeleteEntry,
  onConvertedEntry,
  onSetTemplateDefault,
  onDuplicateTemplate,
  renderNested,
}: EntryPeekSheetProps) {
  const open = Boolean(target);
  const effectiveSpacePath = target?.spacePath ?? spacePath;
  const effectiveProjectPath = target?.projectPath ?? projectPath;
  const effectiveSpaceId = target?.spaceId ?? spaceId;
  const { entry, setEntry, schemaResult, setSchemaResult } = useEntryPeekLoader(
    {
      target,
      spacePath: effectiveSpacePath,
    },
  );

  const contentClassName = useMemo(
    () =>
      cn(
        "gap-0 p-0 pt-5 pb-6 data-[side=right]:sm:max-w-none",
        "shadow-[-24px_0_60px_color-mix(in_oklch,black_20%,transparent)]",
      ),
    [],
  );

  const currentEntry =
    target && entry?.path !== target.entry.path ? target.entry : entry;
  const actionMenu =
    currentEntry && !target?.nested ? (
      <EntryPeekActions
        entry={currentEntry}
        onOpenFullPage={(entryToOpen) =>
          onOpenFullPage(entryToOpen, effectiveSpaceId)
        }
        onDuplicateEntry={onDuplicateEntry}
        onDeleteEntry={onDeleteEntry}
        onConvertedEntry={onConvertedEntry}
        template={target?.template}
        onSetTemplateDefault={onSetTemplateDefault}
        onDuplicateTemplate={onDuplicateTemplate}
        spacePath={effectiveSpacePath}
        projectPath={effectiveProjectPath}
        spaceId={effectiveSpaceId}
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
          <NestedScopePeek
            key={`${effectiveSpaceId}:${currentEntry.path}`}
            entry={currentEntry}
            renderActions={({ surfaceId, viewName }) => {
              const menu = (
                <EntryPeekActions
                  entry={currentEntry}
                  onOpenFullPage={(entryToOpen) =>
                    onOpenFullPage(
                      entryToOpen,
                      effectiveSpaceId,
                      viewName,
                      surfaceId,
                    )
                  }
                  onDuplicateEntry={onDuplicateEntry}
                  onDeleteEntry={onDeleteEntry}
                  onConvertedEntry={onConvertedEntry}
                  template={target.template}
                  onSetTemplateDefault={onSetTemplateDefault}
                  onDuplicateTemplate={onDuplicateTemplate}
                  spacePath={effectiveSpacePath}
                  projectPath={effectiveProjectPath}
                  spaceId={effectiveSpaceId}
                />
              );
              return target.template ? (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {m.collection_template_badge()}
                  </Badge>
                  {menu}
                </div>
              ) : (
                menu
              );
            }}
            renderNested={renderNested}
          />
        ) : currentEntry ? (
          <PeekScrollSurface>
            <EntryPeekSurface
              entry={currentEntry}
              schemaResult={schemaResult}
              spacePath={effectiveSpacePath}
              projectPath={effectiveProjectPath}
              spaceId={effectiveSpaceId}
              actions={actionMenu}
              metadataBefore={
                target?.template ? (
                  <Badge variant="secondary">
                    {m.collection_template_badge()}
                  </Badge>
                ) : null
              }
              onOpenPath={onOpenPath}
              onEntryChange={setEntry}
              onSchemaChange={setSchemaResult}
            />
          </PeekScrollSurface>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function NestedScopePeek({
  entry,
  renderActions,
  renderNested,
}: {
  entry: Entry;
  renderActions: (state: {
    surfaceId: CollectionPeekSurfaceState["surfaceId"];
    viewName: string | null;
  }) => ReactNode;
  renderNested: EntryPeekSheetProps["renderNested"];
}) {
  const [viewName, setViewName] = useState<string | null>(null);
  const [calendarScope, setCalendarScope] = useState<CalendarScope | null>(
    null,
  );
  const [surfaceId, setSurfaceId] =
    useState<CollectionPeekSurfaceState["surfaceId"]>("readme");
  const routeState = useMemo<CollectionRouteState>(
    () => ({
      viewName,
      onViewNameChange: setViewName,
      calendarScope,
      onCalendarScopeChange: setCalendarScope,
    }),
    [calendarScope, viewName],
  );

  return (
    <PeekScrollSurface>
      {renderNested(entry, renderActions({ surfaceId, viewName }), routeState, {
        surfaceId,
        onSurfaceIdChange: setSurfaceId,
      })}
    </PeekScrollSurface>
  );
}

function PeekScrollSurface({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {children}
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
  onOpenFullPage: (entry: Entry, spaceId?: string | null) => void;
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
  const templateDefaultAction =
    template && onSetTemplateDefault ? (
      template.isDefault ? (
        <DropdownMenuItem
          onClick={() => void onSetTemplateDefault(null).catch(handleError)}
        >
          <StarOff data-icon="inline-start" />
          {m.collection_template_unset_default()}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onClick={() =>
            void onSetTemplateDefault(template.slug).catch(handleError)
          }
        >
          <Star data-icon="inline-start" />
          {m.collection_template_set_default()}
        </DropdownMenuItem>
      )
    ) : null;

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onOpenFullPage(entry, spaceId)}
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
        onDuplicateEntry={(entryToDuplicate) => {
          if (template && onDuplicateTemplate) {
            void onDuplicateTemplate(entryToDuplicate).catch(handleError);
            return;
          }
          onDuplicateEntry(entryToDuplicate);
        }}
        onDeleteEntry={onDeleteEntry}
        actionItemsBeforeDuplicate={templateDefaultAction}
        duplicateLabel={
          template ? m.collection_template_duplicate() : undefined
        }
      />
    </div>
  );
}
