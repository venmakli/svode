import { useMemo, type ReactNode } from "react";
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
import {
  EntryDetailActions,
  EntryPeekSurface,
} from "@/features/entry/detail";
import { handleError } from "../lib/errors";
import { useEntryPeekLoader } from "../hooks";
import type { EntryPeekTarget } from "../model";
import * as m from "@/paraglide/messages.js";

interface EntryPeekSheetProps {
  target: EntryPeekTarget | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onOpenChange: (open: boolean) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenPath: (path: string) => void;
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
  onOpenPath,
  onDuplicateEntry,
  onDeleteEntry,
  onConvertedEntry,
  onSetTemplateDefault,
  onDuplicateTemplate,
  renderNested,
}: EntryPeekSheetProps) {
  const open = Boolean(target);
  const { entry, setEntry, schemaResult, setSchemaResult } = useEntryPeekLoader({
    target,
    spacePath,
  });

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
            <EntryPeekSurface
              entry={currentEntry}
              schemaResult={schemaResult}
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              actions={actions}
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
