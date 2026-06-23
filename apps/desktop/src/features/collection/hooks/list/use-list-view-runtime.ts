import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Entry } from "@/features/entry";
import type { ListViewProps } from "../../model/list-types";
import { titleFilter } from "../../lib/utils";
import { entryParentDir } from "../../lib/entry-tree";
import {
  flattenListRows,
  listDensity,
  listMetaColumns,
  normalizeListCardFields,
} from "../../lib/list-view";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionEntryFieldSave } from "../use-collection-entry-field-save";
import { useListEntries } from "./use-list-entries";
import { useListEntryActions } from "./use-list-entry-actions";

export function useListViewRuntime({
  view,
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
  onOpenEntry,
  onOpenNestedPeek,
  onCreateEntry,
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
  const { entries, setEntries, nestedCollectionPaths, loading, loadEntries } =
    useListEntries({
      collectionPath,
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
  const hasActorField = metaColumns.some((column) => column.type === "actor");
  const { createEntry, reorderEntries } = useListEntryActions({
    collectionPath,
    spacePath,
    projectPath,
    entries,
    rows,
    setEntries,
    loadEntries,
    onCreateEntry,
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
      void loadEntries();
    },
    [loadEntries],
  );
  const { commitField } = useCollectionEntryFieldSave({
    spacePath,
    projectPath,
    setEntries,
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
    const created = await createEntry(title, composerAsFolder, () => {
      setComposerOpen(false);
      setComposerValue("");
    });
    if (created) focusRow(created.path);
  }, [composerAsFolder, composerValue, createEntry, focusRow]);

  const toggleRow = useCallback((entry: Entry) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }, []);

  const openRow = useCallback(
    (entry: Entry, nestedCollection: boolean) => {
      if (nestedCollection) onOpenNestedPeek(entry);
      else onOpenEntry(entry);
    },
    [onOpenEntry, onOpenNestedPeek],
  );

  const moveFocus = useCallback(
    (path: string, offset: number) => {
      const index = rows.findIndex((row) => row.entry.path === path);
      const next = rows[index + offset];
      if (next) focusRow(next.entry.path);
    },
    [focusRow, rows],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (hasSort || !event.over || event.active.id === event.over.id) return;
      await reorderEntries(event);
    },
    [hasSort, reorderEntries],
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
    topLevelEntries,
    toggleRow,
  };
}
