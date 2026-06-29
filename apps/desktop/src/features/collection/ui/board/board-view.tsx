import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import { BoardCardContent } from "./board-card";
import { BoardColumn } from "./board-column";
import type { BoardViewProps } from "../../model/board-types";
import { entriesForGroup, isGroupableColumn } from "../../lib/board-view";
import { useBoardViewRuntime } from "../../hooks/board/use-board-view-runtime";
import * as m from "@/paraglide/messages.js";

export function BoardView(props: BoardViewProps) {
  const {
    query,
    spacePath,
    projectPath,
    onClearSearch,
    onOpenEntry,
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onDuplicateEntry,
    onDeleteEntry,
  } = props;
  const runtime = useBoardViewRuntime(props);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (runtime.loading) {
    return (
      <div
        className={`${detailPageViewRowClassName} text-sm text-muted-foreground`}
      />
    );
  }

  if (!runtime.groupColumn || !isGroupableColumn(runtime.groupColumn)) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Settings />
            </EmptyMedia>
            <EmptyTitle>
              {runtime.groupableColumns.length === 0
                ? m.board_no_groupable_title()
                : m.collection_board_incomplete()}
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            {runtime.groupableColumns.length === 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void runtime.addGroupColumn("status").catch(console.error)
                }
              >
                {m.board_add_status_column()}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  runtime.selectGroupColumn(runtime.groupableColumns[0].name)
                }
              >
                {m.view_query_add_group()}
              </Button>
            )}
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const groupColumn = runtime.groupColumn;

  if (
    runtime.topLevelEntries.length === 0 &&
    !runtime.queryFiltered &&
    !runtime.draftGroupKey
  ) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.table_empty()}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runtime.openInitialDraft(false)}
            >
              {m.table_create_first_entry()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  if (
    runtime.topLevelEntries.length === 0 ||
    runtime.filteredEntries.length === 0
  ) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.table_no_results()}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onClearSearch?.();
                query.setLocalQuery({ filter: [] });
              }}
            >
              {m.table_clear_filters()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={runtime.handleDragStart}
      onDragOver={runtime.handleDragOver}
      onDragEnd={(event) => void runtime.handleDragEnd(event)}
      onDragCancel={runtime.handleDragCancel}
    >
      <div className={detailPageViewRowClassName}>
        <ScrollArea>
          <div className="flex min-w-max items-start gap-3 pb-4">
            {runtime.renderedColumns.map((column) => {
              const groupEntries = entriesForGroup(
                runtime.filteredEntries,
                groupColumn,
                column.key,
              );
              const cards = groupEntries.map((entry) => ({
                entry,
                groupKey: column.key,
              }));
              return (
                <BoardColumn
                  key={column.key}
                  group={column}
                  cards={cards}
                  count={groupEntries.length}
                  activeEntryPath={runtime.activeModel?.entry.path ?? null}
                  overGroupKey={runtime.overGroupKey}
                  draftOpen={runtime.draftGroupKey === column.key}
                  draftAsFolder={runtime.draftAsFolder}
                  onPointerEnter={() => {
                    runtime.markActiveGroup(column.key);
                  }}
                  onOpenDraft={(asFolder) => {
                    runtime.openDraftForGroup(column.key, asFolder);
                  }}
                  onCancelDraft={runtime.cancelDraft}
                  onCreateDraft={(title, asFolder) =>
                    void runtime.createDraftForGroup(
                      title,
                      column.key,
                      asFolder,
                    )
                  }
                  cardProps={{
                    groupColumn,
                    cardFields: runtime.cardFields,
                    customColumns: runtime.customColumns,
                    nestedCollectionPaths: runtime.nestedCollectionPaths,
                    disabledReorder: runtime.hasSort,
                    overlay: false,
                    spacePath,
                    projectPath,
                    actors: runtime.actors,
                    onRequestActors: runtime.loadActors,
                    onUpdateField: (entry, column, value) =>
                      void runtime.commitField(entry, column, value),
                    onOpen: onOpenEntry,
                    onOpenNestedPeek,
                    onOpenNestedCollection,
                    onOpenFullPage,
                    onOpenPath,
                    onDuplicate: onDuplicateEntry,
                    onDelete: onDeleteEntry,
                  }}
                />
              );
            })}
          </div>
          <ScrollBar
            orientation="horizontal"
            className="fixed! bottom-2! left-(--svode-main-fixed-left)! right-6! z-30"
          />
        </ScrollArea>
      </div>
      <DragOverlay>
        {runtime.activeModel ? (
          <BoardCardContent
            card={runtime.activeModel}
            groupColumn={groupColumn}
            cardFields={runtime.cardFields}
            customColumns={runtime.customColumns}
            nestedCollectionPaths={runtime.nestedCollectionPaths}
            disabledReorder={runtime.hasSort}
            active
            overlay
            spacePath={spacePath}
            projectPath={projectPath}
            actors={runtime.actors}
            onRequestActors={runtime.loadActors}
            onOpen={onOpenEntry}
            onOpenNestedPeek={onOpenNestedPeek}
            onOpenNestedCollection={onOpenNestedCollection}
            onOpenFullPage={onOpenFullPage}
            onOpenPath={onOpenPath}
            onDuplicate={onDuplicateEntry}
            onDelete={onDeleteEntry}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
