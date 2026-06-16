import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpaceStore } from "@/features/space/model";
import { useStableViewQueryArgs } from "@/features/collection/query";
import type { Entry } from "@/features/entry";
import type { Column } from "@/features/properties";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import {
  listCollectionInfos,
  queryCollectionEntries,
  saveCollectionTreeOrder,
  updateCollectionEntryField,
} from "../../api";
import { useCollectionPersons } from "../../hooks";
import { titleFilter } from "../../lib/utils";
import { entryParentDir, reorderVisibleEntries } from "../table/utils";
import { SortableListRow } from "./list-row";
import type { ListViewProps } from "./types";
import {
  flattenListRows,
  listDensity,
  listMetaColumns,
  normalizeListCardFields,
  replaceSiblings,
  siblingEntries,
} from "./utils";
import * as m from "@/paraglide/messages.js";

export function ListView({
  view,
  query,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onClearSearch,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onDuplicateEntry,
  onDeleteEntry,
  onCreateEntry,
}: ListViewProps) {
  const [entries, setEntries] = useState<EntryState>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerAsFolder, setComposerAsFolder] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const footerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const { persons, loadPersons } = useCollectionPersons(spacePath);
  const queryArgs = useStableViewQueryArgs(filters, sort);
  const refreshTree = useSpaceStore((state) => state.refreshTree);
  const sidebarSpaceId = useSpaceStore((state) => {
    const space =
      state.spaces.find((item) => item.path === spacePath) ??
      state.rootSpaces.find((item) => item.path === spacePath);
    return space?.id ?? null;
  });

  const density = listDensity(view);
  const cardFields = useMemo(
    () => normalizeListCardFields(view, schema),
    [schema, view],
  );
  const metaColumns = useMemo(
    () => listMetaColumns(cardFields, schema),
    [cardFields, schema],
  );
  const topLevelEntries = useMemo(
    () =>
      entries.filter((entry) => entryParentDir(entry.path) === collectionPath),
    [collectionPath, entries],
  );
  const filteredTopLevel = useMemo(
    () => titleFilter(topLevelEntries, searchQuery),
    [searchQuery, topLevelEntries],
  );
  const rows = useMemo(
    () =>
      flattenListRows({
        parents: filteredTopLevel,
        entries,
        expanded,
        collectionPath,
        nestedCollectionPaths,
      }),
    [
      collectionPath,
      entries,
      expanded,
      filteredTopLevel,
      nestedCollectionPaths,
    ],
  );
  const hasSort = sort.length > 0;
  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;
  const hasPersonField = metaColumns.some(
    (column) => column.type === "actor" || column.type === "person",
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEntries, collections] = await Promise.all([
        queryCollectionEntries({
          spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          includeNested: true,
          projectPath,
        }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      setEntries(nextEntries);
      setNestedCollectionPaths(new Set(collections.map((item) => item.path)));
    } catch (error) {
      console.warn("Failed to load list entries:", error);
      toast.error(m.table_error_title());
    } finally {
      setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  useEffect(() => {
    if (!hasPersonField) return;
    void loadPersons().catch((error) => {
      console.warn("Failed to load list persons:", error);
    });
  }, [hasPersonField, loadPersons]);

  useEffect(() => {
    if (!composerOpen) return;
    inputRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    setComposerOpen(true);
    setComposerAsFolder(createAsFolder);
    window.requestAnimationFrame(() => {
      footerRef.current?.scrollIntoView({ block: "nearest" });
      inputRef.current?.focus();
    });
  }, [createAsFolder, createFocusSignal]);

  const commitField = useCallback(
    async (entry: Entry, column: Column, value: unknown) => {
      const applyValue = (item: EntryState[number]) => {
        const extra = { ...item.meta.extra };
        if (isClearedPropertyValue(value)) delete extra[column.name];
        else extra[column.name] = value;
        return { ...item, meta: { ...item.meta, extra } };
      };

      setEntries((current) =>
        current.map((item) =>
          item.path === entry.path ? applyValue(item) : item,
        ),
      );
      try {
        const updated = await updateCollectionEntryField({
          spacePath,
          filePath: entry.path,
          field: column.name,
          value,
          projectPath,
        });
        setEntries((current) =>
          current.map((item) => (item.path === entry.path ? updated : item)),
        );
      } catch (error) {
        console.warn("Failed to update list field:", error);
        void loadEntries();
      }
    },
    [loadEntries, projectPath, spacePath],
  );

  async function createDraft() {
    const title = composerValue.trim();
    if (!title) {
      setComposerOpen(false);
      setComposerValue("");
      return;
    }
    try {
      const created = await onCreateEntry(title, composerAsFolder);
      setComposerOpen(false);
      setComposerValue("");
      setEntries((current) => [...current, created]);
      if (sidebarSpaceId) await refreshTree(sidebarSpaceId);
      await loadEntries();
      focusRow(created.path);
    } catch (error) {
      console.warn("Failed to create list entry:", error);
      toast.error(m.board_create_error());
    }
  }

  function toggleRow(entry: EntryState[number]) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function openRow(entry: Entry, nestedCollection: boolean) {
    if (nestedCollection) onOpenNestedPeek(entry);
    else onOpenEntry(entry);
  }

  function focusRow(path: string) {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(path)?.focus();
    });
  }

  function moveFocus(path: string, offset: number) {
    const index = rows.findIndex((row) => row.entry.path === path);
    const next = rows[index + offset];
    if (next) focusRow(next.entry.path);
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (hasSort || !event.over || event.active.id === event.over.id) return;
    const activePath = String(event.active.id);
    const overPath = String(event.over.id);
    const activeEntry = entries.find((entry) => entry.path === activePath);
    const overEntry = entries.find((entry) => entry.path === overPath);
    if (!activeEntry || !overEntry) return;

    const parentPath = entryParentDir(activeEntry.path);
    if (parentPath !== entryParentDir(overEntry.path)) return;

    const siblings = siblingEntries(entries, parentPath);
    const visibleSiblings = rows
      .map((row) => row.entry)
      .filter((entry) => entryParentDir(entry.path) === parentPath);
    const nextVisibleIndex = visibleSiblings.findIndex(
      (entry) => entry.path === overPath,
    );
    const nextSiblings = reorderVisibleEntries(
      siblings,
      visibleSiblings,
      activePath,
      nextVisibleIndex,
    );
    const previousEntries = entries;
    setEntries((current) => replaceSiblings(current, parentPath, nextSiblings));
    try {
      await saveCollectionTreeOrder({
        spacePath,
        orderKey: parentPath,
        entries: nextSiblings,
        projectPath,
      });
      if (sidebarSpaceId) await refreshTree(sidebarSpaceId);
      await loadEntries();
    } catch (error) {
      console.warn("Failed to reorder list entries:", error);
      setEntries(previousEntries);
      toast.error(m.board_move_error());
    }
  }

  if (loading) return <ListSkeleton density={density} />;

  if (topLevelEntries.length === 0 && !queryFiltered && !composerOpen) {
    return (
      <EmptyState
        title={m.table_empty()}
        action={m.table_create_first_entry()}
        onAction={() => {
          setComposerOpen(true);
          setComposerAsFolder(false);
        }}
      />
    );
  }

  if (topLevelEntries.length === 0 || filteredTopLevel.length === 0) {
    return (
      <EmptyState
        title={m.table_no_results()}
        action={m.table_clear_filters()}
        onAction={() => {
          onClearSearch?.();
          query.setLocalQuery({ filter: [] });
        }}
      />
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => void handleDragEnd(event)}
    >
      <div className={detailPageViewRowClassName}>
        <div className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
          <SortableContext
            items={rows.map((row) => row.entry.path)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((row) => (
              <SortableListRow
                key={row.entry.path}
                row={row}
                density={density}
                cardFields={cardFields}
                metaColumns={metaColumns}
                spacePath={spacePath}
                projectPath={projectPath}
                persons={persons}
                disabledReorder={hasSort}
                focused={focusedPath === row.entry.path}
                rowRef={(element) => {
                  if (element) rowRefs.current.set(row.entry.path, element);
                  else rowRefs.current.delete(row.entry.path);
                }}
                onRequestPersons={loadPersons}
                onUpdateField={(entry, column, value) =>
                  void commitField(entry, column, value)
                }
                onToggle={toggleRow}
                onOpen={openRow}
                onOpenFullPage={onOpenFullPage}
                onOpenNestedCollection={onOpenNestedCollection}
                onDuplicate={onDuplicateEntry}
                onDelete={onDeleteEntry}
                onFocusRow={setFocusedPath}
                onKeyboardMove={moveFocus}
              />
            ))}
          </SortableContext>
        </div>
        <div
          ref={footerRef}
          className="flex items-center justify-between gap-3 px-1 py-3"
        >
          {composerOpen ? (
            <Input
              ref={inputRef}
              value={composerValue}
              placeholder={m.table_new_entry_placeholder()}
              className="h-8 max-w-sm"
              onChange={(event) => setComposerValue(event.target.value)}
              onBlur={() => {
                if (!composerValue.trim()) {
                  setComposerOpen(false);
                  setComposerAsFolder(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createDraft();
                if (event.key === "Escape") {
                  setComposerOpen(false);
                  setComposerValue("");
                  setComposerAsFolder(false);
                }
              }}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={(event) => {
                setComposerOpen(true);
                setComposerAsFolder(event.shiftKey);
              }}
            >
              <Plus data-icon="inline-start" />
              {m.table_new_entry_placeholder()}
            </Button>
          )}
          <span className="shrink-0 text-xs text-muted-foreground">
            {m.table_entries_count({ count: rows.length })}
          </span>
        </div>
      </div>
    </DndContext>
  );
}

function EmptyState({
  title,
  action,
  onAction,
}: {
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex p-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Settings />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={onAction}>
            {action}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function ListSkeleton({ density }: { density: "compact" | "comfortable" }) {
  return (
    <div className={detailPageViewRowClassName}>
      <div className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <Skeleton className="size-4" />
            <div className="flex min-w-0 flex-col gap-2">
              <Skeleton className="h-4 w-48 max-w-full" />
              {density === "comfortable" ? (
                <Skeleton className="h-3 w-72 max-w-full" />
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type EntryState = Awaited<ReturnType<typeof queryCollectionEntries>>;

function isClearedPropertyValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}
