import { Copy, FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { CollectionView, ViewType } from "@/features/collection/query/model";
import type { CollectionSchema } from "@/features/properties";
import type { Entry } from "@/features/entry";
import { useViewPlaceholderEntries } from "../hooks";
import { IncompleteState } from "./incomplete-state";
import { titleFilter } from "../lib/utils";
import * as m from "@/paraglide/messages.js";

export function ViewPlaceholder({
  type,
  name,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  searchQuery,
  refreshToken,
  onOpenEntry,
  onDuplicateEntry,
  onDeleteEntry,
}: {
  type: ViewType;
  name: string;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  searchQuery: string;
  refreshToken: number;
  onOpenEntry: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
}) {
  const entries = useViewPlaceholderEntries({
    spacePath,
    collectionPath,
    viewName: name,
    projectPath,
    refreshToken,
  });

  const filtered = titleFilter(entries, searchQuery);
  const needsGroup =
    type === "board" &&
    !((schema.views ?? []) as CollectionView[]).find(
      (view) => view.name === name,
    )?.group_by;
  const needsDate =
    type === "calendar" &&
    !((schema.views ?? []) as CollectionView[]).find(
      (view) => view.name === name,
    )?.date_field;

  if (needsGroup) {
    return (
      <IncompleteState
        title={m.collection_board_incomplete()}
        action={m.collection_add_group_property()}
      />
    );
  }
  if (needsDate) {
    return (
      <IncompleteState
        title={m.collection_calendar_incomplete()}
        action={m.collection_add_date_property()}
      />
    );
  }

  return (
    <div className="flex flex-col px-6 py-4">
      {filtered.length === 0 ? (
        <Empty className="min-h-48 flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>{m.collection_no_entries()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border bg-background">
          {filtered.slice(0, 20).map((entry) => (
            <ContextMenu key={entry.path}>
              <ContextMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex w-full justify-start gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                  onClick={() => onOpenEntry(entry)}
                >
                  <FileText />
                  <span className="truncate">{entry.meta.title}</span>
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onClick={() => onOpenEntry(entry)}>
                  <FileText data-icon="inline-start" />
                  {m.collection_open_in_peek()}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onDuplicateEntry(entry)}>
                  <Copy data-icon="inline-start" />
                  {m.collection_duplicate_entry()}
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDeleteEntry(entry)}
                >
                  <Trash2 data-icon="inline-start" />
                  {m.space_delete()}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
    </div>
  );
}
