import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
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
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useStableViewQueryArgs } from "@/features/collection/query";
import { useEntryFieldSave, type Entry } from "@/features/entry";
import { propertyFieldSavePolicy, type Column } from "@/features/properties";
import { useSpace } from "@/features/space";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import {
  listCollectionInfos,
  queryCollectionEntries,
  saveCollectionTreeOrder,
} from "../../api";
import { useCollectionPersons } from "../../hooks";
import { titleFilter } from "../../lib/utils";
import { entryParentDir, reorderVisibleEntries } from "../table/utils";
import { SortableGalleryCard } from "./gallery-card";
import type { GalleryViewProps } from "./types";
import {
  galleryCardCover,
  galleryCardWidth,
  galleryCoverAspect,
  galleryCoverFit,
  galleryMetaColumns,
  isFolderEntry,
  isNestedCollectionEntry,
  normalizeGalleryCardFields,
} from "./utils";
import * as m from "@/paraglide/messages.js";

export function GalleryView({
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
}: GalleryViewProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftAsFolder, setDraftAsFolder] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const { persons, loadPersons } = useCollectionPersons(spacePath);
  const queryArgs = useStableViewQueryArgs(filters, sort);
  const reloadTreeParent = useSpace((state) => state.reloadTreeParent);
  const sidebarSpaceId = useSpace((state) => {
    const space =
      state.spaces.find((item) => item.path === spacePath) ??
      state.rootSpaces.find((item) => item.path === spacePath);
    return space?.id ?? null;
  });

  const cardWidth = galleryCardWidth(view);
  const cardFields = useMemo(
    () => normalizeGalleryCardFields(view, schema),
    [schema, view],
  );
  const metaColumns = useMemo(
    () => galleryMetaColumns(cardFields, schema),
    [cardFields, schema],
  );
  const cardCover = useMemo(() => galleryCardCover(view), [view]);
  const coverFit = galleryCoverFit(view);
  const coverAspect = galleryCoverAspect(view);
  const topLevelEntries = useMemo(
    () =>
      entries.filter((entry) => entryParentDir(entry.path) === collectionPath),
    [collectionPath, entries],
  );
  const filteredEntries = useMemo(
    () => titleFilter(topLevelEntries, searchQuery),
    [searchQuery, topLevelEntries],
  );
  const hasSort = sort.length > 0;
  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;
  const hasPersonField = metaColumns.some(
    (column) => column.type === "actor" || column.type === "person",
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 160, tolerance: 6 },
    }),
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
          includeNested: false,
          projectPath,
        }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      setEntries(nextEntries);
      setNestedCollectionPaths(new Set(collections.map((item) => item.path)));
    } catch (error) {
      console.warn("Failed to load gallery entries:", error);
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
      console.warn("Failed to load gallery persons:", error);
    });
  }, [hasPersonField, loadPersons]);

  useEffect(() => {
    if (!draftOpen) return;
    inputRef.current?.focus();
  }, [draftOpen]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    setDraftOpen(true);
    setDraftAsFolder(createAsFolder);
    window.requestAnimationFrame(() => {
      draftRef.current?.scrollIntoView({ block: "nearest" });
      inputRef.current?.focus();
    });
  }, [createAsFolder, createFocusSignal]);

  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [],
  );
  const saveEntryField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
  });

  const commitField = useCallback(
    async (entry: Entry, column: Column, value: unknown) => {
      try {
        await saveEntryField(entry, column.name, value, {
          policy: propertyFieldSavePolicy(column),
        });
      } catch (error) {
        console.warn("Failed to update gallery field:", error);
        void loadEntries();
      }
    },
    [loadEntries, saveEntryField],
  );

  async function createDraft() {
    const title = draftValue.trim();
    if (!title) {
      setDraftOpen(false);
      setDraftValue("");
      return;
    }
    try {
      const created = await onCreateEntry(title, draftAsFolder);
      setDraftOpen(false);
      setDraftValue("");
      setEntries((current) => [...current, created]);
      if (sidebarSpaceId)
        await reloadTreeParent(sidebarSpaceId, collectionPath);
      await loadEntries();
      focusCard(created.path);
    } catch (error) {
      console.warn("Failed to create gallery entry:", error);
      toast.error(m.board_create_error());
    }
  }

  function openCard(entry: Entry, nestedCollection: boolean) {
    if (nestedCollection) onOpenNestedPeek(entry);
    else onOpenEntry(entry);
  }

  function focusCard(path: string) {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      cardRefs.current.get(path)?.focus();
    });
  }

  function moveFocus(
    path: string,
    direction: "left" | "right" | "up" | "down",
  ) {
    const index = filteredEntries.findIndex((entry) => entry.path === path);
    if (index < 0) return;
    const columns = currentColumnCount();
    const offset =
      direction === "left"
        ? -1
        : direction === "right"
          ? 1
          : direction === "up"
            ? -columns
            : columns;
    const next = filteredEntries[index + offset];
    if (next) focusCard(next.path);
  }

  function currentColumnCount() {
    const width = gridRef.current?.clientWidth ?? cardWidth;
    return Math.max(1, Math.floor((width + 14) / (cardWidth + 14)));
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (hasSort || !event.over || event.active.id === event.over.id) return;
    const activePath = String(event.active.id);
    const overPath = String(event.over.id);
    const nextVisibleIndex = filteredEntries.findIndex(
      (entry) => entry.path === overPath,
    );
    const nextEntries = reorderVisibleEntries(
      topLevelEntries,
      filteredEntries,
      activePath,
      nextVisibleIndex,
    );
    const previousEntries = entries;
    setEntries((current) => [
      ...nextEntries,
      ...current.filter(
        (entry) => entryParentDir(entry.path) !== collectionPath,
      ),
    ]);
    try {
      await saveCollectionTreeOrder({
        spacePath,
        orderKey: collectionPath,
        entries: nextEntries,
        projectPath,
      });
      if (sidebarSpaceId)
        await reloadTreeParent(sidebarSpaceId, collectionPath);
      await loadEntries();
    } catch (error) {
      console.warn("Failed to reorder gallery entries:", error);
      setEntries(previousEntries);
      toast.error(m.board_move_error());
    }
  }

  if (loading) return <GallerySkeleton cardWidth={cardWidth} />;

  if (topLevelEntries.length === 0 && !queryFiltered && !draftOpen) {
    return (
      <EmptyState
        title={m.table_empty()}
        action={m.table_create_first_entry()}
        onAction={() => {
          setDraftOpen(true);
          setDraftAsFolder(false);
        }}
      />
    );
  }

  if (topLevelEntries.length === 0 || filteredEntries.length === 0) {
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
        <div
          ref={gridRef}
          className="grid items-stretch gap-3.5"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
          }}
        >
          <SortableContext
            items={filteredEntries.map((entry) => entry.path)}
            strategy={rectSortingStrategy}
          >
            {filteredEntries.map((entry) => {
              const nestedCollection = isNestedCollectionEntry(
                entry,
                nestedCollectionPaths,
              );
              return (
                <SortableGalleryCard
                  key={entry.path}
                  entry={entry}
                  schema={schema}
                  cardCover={cardCover}
                  cardFields={cardFields}
                  metaColumns={metaColumns}
                  coverFit={coverFit}
                  coverAspect={coverAspect}
                  spacePath={spacePath}
                  projectPath={projectPath}
                  persons={persons}
                  nestedCollection={nestedCollection}
                  folder={isFolderEntry(entry)}
                  disabledReorder={hasSort}
                  focused={focusedPath === entry.path}
                  cardRef={(element) => {
                    if (element) cardRefs.current.set(entry.path, element);
                    else cardRefs.current.delete(entry.path);
                  }}
                  onRequestPersons={loadPersons}
                  onUpdateField={(entryToUpdate, column, value) =>
                    void commitField(entryToUpdate, column, value)
                  }
                  onOpen={openCard}
                  onOpenFullPage={onOpenFullPage}
                  onOpenNestedCollection={onOpenNestedCollection}
                  onDuplicate={onDuplicateEntry}
                  onDelete={onDeleteEntry}
                  onFocusCard={setFocusedPath}
                  onKeyboardMove={moveFocus}
                />
              );
            })}
          </SortableContext>
          <GalleryCreateTile
            refElement={draftRef}
            open={draftOpen}
            value={draftValue}
            onOpen={(asFolder) => {
              setDraftOpen(true);
              setDraftAsFolder(asFolder);
            }}
            onValueChange={setDraftValue}
            inputRef={inputRef}
            onCreate={() => void createDraft()}
            onCancel={() => {
              setDraftOpen(false);
              setDraftValue("");
              setDraftAsFolder(false);
            }}
          />
        </div>
      </div>
    </DndContext>
  );
}

function GalleryCreateTile({
  refElement,
  open,
  value,
  inputRef,
  onOpen,
  onValueChange,
  onCreate,
  onCancel,
}: {
  refElement: RefObject<HTMLDivElement | null>;
  open: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen: (asFolder: boolean) => void;
  onValueChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <Card
      ref={refElement}
      className="h-full min-h-44 justify-center border-dashed bg-muted/20 py-0 shadow-none ring-1 ring-foreground/10 transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-sm"
    >
      <CardContent className="flex min-h-44 flex-col items-center justify-center gap-3 p-3">
        {open ? (
          <Input
            ref={inputRef}
            value={value}
            placeholder={m.table_new_entry_placeholder()}
            className="h-8"
            onChange={(event) => onValueChange(event.target.value)}
            onBlur={() => {
              if (!value.trim()) onCancel();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCreate();
              if (event.key === "Escape") onCancel();
            }}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={(event) => onOpen(event.shiftKey)}
          >
            <Plus data-icon="inline-start" />
            {m.table_new_entry_placeholder()}
          </Button>
        )}
      </CardContent>
    </Card>
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

function GallerySkeleton({ cardWidth }: { cardWidth: number }) {
  return (
    <div className={detailPageViewRowClassName}>
      <div
        className="grid gap-3.5"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
        }}
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <Card
            key={index}
            size="sm"
            className="gap-0 overflow-hidden py-0 shadow-none ring-1 ring-foreground/10"
          >
            <Skeleton className="aspect-video w-full rounded-none" />
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-5 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
