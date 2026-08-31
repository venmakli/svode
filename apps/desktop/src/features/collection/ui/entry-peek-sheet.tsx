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
import { resolveLoadedPeekEntry, useEntryPeekLoader } from "../hooks";
import type {
  CollectionPeekSurfaceState,
  CollectionRouteState,
  EntryPeekTarget,
} from "../model";
import type { CalendarScope } from "../model/calendar-types";
import { useOptionalCollectionDetailController } from "../app-shell";
import * as m from "@/paraglide/messages.js";

interface EntryPeekSheetProps {
  readOnly: boolean;
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
    sessionKey: string,
  ) => ReactNode;
}

export function EntryPeekSheet({
  readOnly,
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
  const detailController = useOptionalCollectionDetailController();
  const open = Boolean(target);
  const effectiveSpacePath = target?.spacePath ?? spacePath;
  const effectiveProjectPath = target?.projectPath ?? projectPath;
  const effectiveSpaceId = target?.spaceId ?? spaceId;
  const {
    entry,
    setEntry,
    schemaResult,
    setSchemaResult,
    loadedTargetKey,
    pathHandoff,
    targetKey,
  } = useEntryPeekLoader({
    target,
    spacePath: effectiveSpacePath,
    spaceId: effectiveSpaceId,
  });

  const contentClassName = useMemo(
    () =>
      cn(
        "gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none",
        "shadow-[-24px_0_60px_color-mix(in_oklch,black_20%,transparent)]",
      ),
    [],
  );

  const currentEntry = resolveLoadedPeekEntry(
    target,
    entry,
    loadedTargetKey,
    targetKey,
  );
  const detailActions =
    currentEntry && !target?.nested ? (
      <EntryPeekActions
        entry={currentEntry}
        readOnly={readOnly}
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
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !detailController) {
          onOpenChange(nextOpen);
          return;
        }
        void detailController.prepareForNavigation().then((canClose) => {
          if (canClose) {
            onOpenChange(false);
          }
        });
      }}
    >
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
            key={targetKey ?? undefined}
            entry={currentEntry}
            sessionKey={targetKey ?? `${effectiveSpaceId}:${target.entry.path}`}
            renderActions={({ surfaceId, viewName }) => {
              const detail = (
                <EntryPeekActions
                  entry={currentEntry}
                  readOnly={readOnly}
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
              return {
                peek: (
                  <EntryPeekControls
                    entry={currentEntry}
                    onOpenFullPage={(entryToOpen) =>
                      onOpenFullPage(
                        entryToOpen,
                        effectiveSpaceId,
                        viewName,
                        surfaceId,
                      )
                    }
                  />
                ),
                detail: target.template ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {m.collection_template_badge()}
                    </Badge>
                    {detail}
                  </div>
                ) : (
                  detail
                ),
              };
            }}
            renderNested={renderNested}
          />
        ) : currentEntry ? (
          <>
            <PeekTopBar>
              <EntryPeekControls
                entry={currentEntry}
                onOpenFullPage={(entryToOpen) =>
                  onOpenFullPage(entryToOpen, effectiveSpaceId)
                }
              />
            </PeekTopBar>
            <PeekScrollSurface>
              <EntryPeekSurface
                readOnly={readOnly}
                entry={currentEntry}
                schemaResult={schemaResult}
                spacePath={effectiveSpacePath}
                projectPath={effectiveProjectPath}
                spaceId={effectiveSpaceId}
                documentPathHandoff={pathHandoff}
                actions={detailActions}
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
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function NestedScopePeek({
  entry,
  sessionKey,
  renderActions,
  renderNested,
}: {
  entry: Entry;
  sessionKey: string;
  renderActions: (state: {
    surfaceId: CollectionPeekSurfaceState["surfaceId"];
    viewName: string | null;
  }) => { peek: ReactNode; detail: ReactNode };
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
  const actions = renderActions({ surfaceId, viewName });

  return (
    <>
      <PeekTopBar>{actions.peek}</PeekTopBar>
      <PeekScrollSurface>
        {renderNested(
          entry,
          actions.detail,
          routeState,
          {
            surfaceId,
            onSurfaceIdChange: setSurfaceId,
          },
          sessionKey,
        )}
      </PeekScrollSurface>
    </>
  );
}

function PeekTopBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end px-2 pb-2">
      {children}
    </div>
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
  readOnly,
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
  readOnly: boolean;
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
    !readOnly && template && onSetTemplateDefault ? (
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
      duplicateLabel={template ? m.collection_template_duplicate() : undefined}
      readOnly={readOnly}
    />
  );
}

function EntryPeekControls({
  entry,
  onOpenFullPage,
}: {
  entry: Entry;
  onOpenFullPage: (entry: Entry) => void;
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
    </div>
  );
}
