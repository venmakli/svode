import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import type { ListViewProps } from "../../model/list-types";
import { titleFilter } from "../../lib/utils";
import { itemParentDir } from "../../lib/item-tree";
import {
  flattenListRows,
  listDensity,
  listMetaColumns,
  normalizeListCardFields,
} from "../../lib/list-view";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionItemFieldSave } from "../use-collection-item-field-save";
import { useListItems } from "./use-list-items";
import { useListItemActions } from "./use-list-item-actions";

export function useListViewRuntime({
  view,
  schema,
  collectionPath,
  previousCollectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onActivateItem,
  onOpenNestedPeek,
  onCreatePage,
}: ListViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerAsFolder, setComposerAsFolder] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const footerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const { actors, loadActors } = useCollectionActors(spacePath);
  const { items, setItems, nestedCollectionPaths, loading, loadItems } =
    useListItems({
      collectionPath,
      previousCollectionPath,
      filters,
      projectPath,
      refreshToken,
      sort,
      spacePath,
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
  const topLevelItems = useMemo(
    () => items.filter((item) => itemParentDir(item.path) === collectionPath),
    [collectionPath, items],
  );
  const filteredTopLevel = useMemo(
    () => titleFilter(topLevelItems, searchQuery),
    [searchQuery, topLevelItems],
  );
  const rows = useMemo(
    () =>
      flattenListRows({
        parents: filteredTopLevel,
        items,
        expanded,
        collectionPath,
        nestedCollectionPaths,
      }),
    [collectionPath, items, expanded, filteredTopLevel, nestedCollectionPaths],
  );
  const hasSort = sort.length > 0;
  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;
  const hasActorField = metaColumns.some((column) => column.type === "actor");
  const { createItem, reorderItems } = useListItemActions({
    collectionPath,
    spacePath,
    projectPath,
    items,
    rows,
    setItems,
    loadItems,
    onCreatePage,
  });

  useEffect(() => {
    if (!hasActorField) return;
    void loadActors().catch((error) => {
      console.warn("Failed to load list actors:", error);
    });
  }, [hasActorField, loadActors]);

  useEffect(() => {
    if (!composerOpen) return;
    inputRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setComposerOpen(true);
      setComposerAsFolder(createAsFolder);
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        footerRef.current?.scrollIntoView({ block: "nearest" });
        inputRef.current?.focus();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [createAsFolder, createFocusSignal]);

  const handleFieldCommitError = useCallback(
    (error: unknown) => {
      console.warn("Failed to update list field:", error);
      void loadItems();
    },
    [loadItems],
  );
  const { commitField } = useCollectionItemFieldSave({
    spacePath,
    projectPath,
    setItems,
    onCommitError: handleFieldCommitError,
  });

  const focusRow = useCallback((path: string) => {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(path)?.focus();
    });
  }, []);

  const createDraft = useCallback(async () => {
    const title = composerValue.trim();
    if (!title) {
      setComposerOpen(false);
      setComposerValue("");
      return;
    }
    const created = await createItem(title, composerAsFolder, () => {
      setComposerOpen(false);
      setComposerValue("");
    });
    if (created) focusRow(created.path);
  }, [composerAsFolder, composerValue, createItem, focusRow]);

  const toggleRow = useCallback((item: Page) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  }, []);

  const openRow = useCallback(
    (item: Page, nestedCollection: boolean) => {
      if (nestedCollection) onOpenNestedPeek(item);
      else onActivateItem(item);
    },
    [onActivateItem, onOpenNestedPeek],
  );

  const moveFocus = useCallback(
    (path: string, offset: number) => {
      const index = rows.findIndex((row) => row.item.path === path);
      const next = rows[index + offset];
      if (next) focusRow(next.item.path);
    },
    [focusRow, rows],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (hasSort || !event.over || event.active.id === event.over.id) return;
      await reorderItems(event);
    },
    [hasSort, reorderItems],
  );

  const openComposer = useCallback((asFolder: boolean) => {
    setComposerOpen(true);
    setComposerAsFolder(asFolder);
  }, []);

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerAsFolder(false);
  }, []);

  const cancelComposer = useCallback(() => {
    closeComposer();
    setComposerValue("");
  }, [closeComposer]);

  const rowRef = useCallback((path: string, element: HTMLElement | null) => {
    if (element) rowRefs.current.set(path, element);
    else rowRefs.current.delete(path);
  }, []);

  return {
    actors,
    cardFields,
    closeComposer,
    cancelComposer,
    commitField,
    composerOpen,
    composerValue,
    createDraft,
    density,
    filteredTopLevel,
    focusedPath,
    footerRef,
    handleDragEnd,
    hasSort,
    inputRef,
    loadActors,
    loading,
    metaColumns,
    moveFocus,
    openComposer,
    openRow,
    queryFiltered,
    rowRef,
    rows,
    setComposerValue,
    setFocusedPath,
    topLevelItems,
    toggleRow,
  };
}
