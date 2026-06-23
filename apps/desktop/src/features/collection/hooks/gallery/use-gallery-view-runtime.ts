import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Entry } from "@/features/entry";
import type { GalleryViewProps } from "../../model/gallery-types";
import { titleFilter } from "../../lib/utils";
import { entryParentDir } from "../../lib/entry-tree";
import {
  galleryCardCover,
  galleryCardWidth,
  galleryCoverAspect,
  galleryCoverFit,
  galleryMetaColumns,
  normalizeGalleryCardFields,
} from "../../lib/gallery-view";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionEntryFieldSave } from "../use-collection-entry-field-save";
import { resolveGalleryCover } from "./resolve-gallery-cover";
import { useGalleryEntries } from "./use-gallery-entries";
import { useGalleryEntryActions } from "./use-gallery-entry-actions";

export function useGalleryViewRuntime({
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
}: GalleryViewProps) {
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftAsFolder, setDraftAsFolder] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const { actors, loadActors } = useCollectionActors(spacePath);
  const { entries, setEntries, nestedCollectionPaths, loading, loadEntries } =
    useGalleryEntries({
      collectionPath,
      filters,
      projectPath,
      refreshToken,
      sort,
      spacePath,
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
  const resolveCover = useCallback(
    (entry: Entry) =>
      resolveGalleryCover({
        entry,
        cardCover,
        schema,
        spacePath,
      }),
    [cardCover, schema, spacePath],
  );
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
  const hasActorField = metaColumns.some((column) => column.type === "actor");
  const { createEntry, reorderEntries } = useGalleryEntryActions({
    collectionPath,
    spacePath,
    projectPath,
    entries,
    topLevelEntries,
    filteredEntries,
    setEntries,
    loadEntries,
    onCreateEntry,
  });

  useEffect(() => {
    if (!hasActorField) return;
    void loadActors().catch((error) => {
      console.warn("Failed to load gallery actors:", error);
    });
  }, [hasActorField, loadActors]);

  useEffect(() => {
    if (!draftOpen) return;
    inputRef.current?.focus();
  }, [draftOpen]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDraftOpen(true);
      setDraftAsFolder(createAsFolder);
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        draftRef.current?.scrollIntoView({ block: "nearest" });
        inputRef.current?.focus();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [createAsFolder, createFocusSignal]);

  const handleFieldCommitError = useCallback(
    (error: unknown) => {
      console.warn("Failed to update gallery field:", error);
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

  const focusCard = useCallback((path: string) => {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      cardRefs.current.get(path)?.focus();
    });
  }, []);

  const createDraft = useCallback(async () => {
    const title = draftValue.trim();
    if (!title) {
      setDraftOpen(false);
      setDraftValue("");
      return;
    }
    const created = await createEntry(title, draftAsFolder, () => {
      setDraftOpen(false);
      setDraftValue("");
    });
    if (created) focusCard(created.path);
  }, [createEntry, draftAsFolder, draftValue, focusCard]);

  const openCard = useCallback(
    (entry: Entry, nestedCollection: boolean) => {
      if (nestedCollection) onOpenNestedPeek(entry);
      else onOpenEntry(entry);
    },
    [onOpenEntry, onOpenNestedPeek],
  );

  const currentColumnCount = useCallback(() => {
    const width = gridRef.current?.clientWidth ?? cardWidth;
    return Math.max(1, Math.floor((width + 14) / (cardWidth + 14)));
  }, [cardWidth]);

  const moveFocus = useCallback(
    (path: string, direction: "left" | "right" | "up" | "down") => {
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
    },
    [currentColumnCount, filteredEntries, focusCard],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (hasSort || !event.over || event.active.id === event.over.id) return;
      await reorderEntries(event);
    },
    [hasSort, reorderEntries],
  );

  const openDraft = useCallback((asFolder: boolean) => {
    setDraftOpen(true);
    setDraftAsFolder(asFolder);
  }, []);

  const closeDraft = useCallback(() => {
    setDraftOpen(false);
    setDraftAsFolder(false);
  }, []);

  const cancelDraft = useCallback(() => {
    closeDraft();
    setDraftValue("");
  }, [closeDraft]);

  const cardRef = useCallback((path: string, element: HTMLElement | null) => {
    if (element) cardRefs.current.set(path, element);
    else cardRefs.current.delete(path);
  }, []);

  return {
    actors,
    cardFields,
    cardRef,
    cardWidth,
    cancelDraft,
    closeDraft,
    commitField,
    coverAspect,
    coverFit,
    createDraft,
    draftOpen,
    draftRef,
    draftValue,
    filteredEntries,
    focusedPath,
    gridRef,
    handleDragEnd,
    hasSort,
    inputRef,
    loadActors,
    loading,
    metaColumns,
    moveFocus,
    nestedCollectionPaths,
    openCard,
    openDraft,
    queryFiltered,
    resolveCover,
    setDraftValue,
    setFocusedPath,
    topLevelEntries,
  };
}
