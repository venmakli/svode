import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import type { GalleryViewProps } from "../../model/gallery-types";
import type { GalleryNavigationKey } from "../../ui/gallery/types";
import { titleFilter } from "../../lib/utils";
import { itemParentDir } from "../../lib/item-tree";
import {
  galleryCardCover,
  galleryCardWidth,
  galleryCoverAspect,
  galleryCoverFit,
  galleryMetaColumns,
  normalizeGalleryCardFields,
} from "../../lib/gallery-view";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionItemFieldSave } from "../use-collection-item-field-save";
import { resolveGalleryCover } from "./resolve-gallery-cover";
import { useGalleryItems } from "./use-gallery-items";
import { useGalleryItemActions } from "./use-gallery-item-actions";

export function useGalleryViewRuntime({
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
  const { items, setItems, nestedCollectionPaths, loading, loadItems } =
    useGalleryItems({
      collectionPath,
      previousCollectionPath,
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
    (item: Page) =>
      resolveGalleryCover({
        item,
        cardCover,
        schema,
        spacePath,
      }),
    [cardCover, schema, spacePath],
  );
  const topLevelItems = useMemo(
    () => items.filter((item) => itemParentDir(item.path) === collectionPath),
    [collectionPath, items],
  );
  const filteredItems = useMemo(
    () => titleFilter(topLevelItems, searchQuery),
    [searchQuery, topLevelItems],
  );
  const hasSort = sort.length > 0;
  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;
  const hasActorField = metaColumns.some((column) => column.type === "actor");
  const { createItem, reorderItems } = useGalleryItemActions({
    collectionPath,
    spacePath,
    projectPath,
    items,
    topLevelItems,
    filteredItems,
    setItems,
    loadItems,
    onCreatePage,
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
    const created = await createItem(title, draftAsFolder, () => {
      setDraftOpen(false);
      setDraftValue("");
    });
    if (created) focusCard(created.path);
  }, [createItem, draftAsFolder, draftValue, focusCard]);

  const openCard = useCallback(
    (item: Page, nestedCollection: boolean) => {
      if (nestedCollection) onOpenNestedPeek(item);
      else onActivateItem(item);
    },
    [onActivateItem, onOpenNestedPeek],
  );

  const currentColumnCount = useCallback(() => {
    const width = gridRef.current?.clientWidth ?? cardWidth;
    return Math.max(1, Math.floor((width + 14) / (cardWidth + 14)));
  }, [cardWidth]);

  const moveFocus = useCallback(
    (path: string, key: GalleryNavigationKey) => {
      const index = filteredItems.findIndex((item) => item.path === path);
      if (index < 0) return;
      const columns = currentColumnCount();
      const offset =
        key === "ArrowLeft"
          ? -1
          : key === "ArrowRight"
            ? 1
            : key === "ArrowUp"
              ? -columns
              : key === "ArrowDown"
                ? columns
                : 0;
      const nextIndex =
        key === "Home"
          ? 0
          : key === "End"
            ? filteredItems.length - 1
            : index + offset;
      const next = filteredItems[nextIndex];
      if (next) focusCard(next.path);
    },
    [currentColumnCount, filteredItems, focusCard],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (hasSort || !event.over || event.active.id === event.over.id) return;
      await reorderItems(event);
    },
    [hasSort, reorderItems],
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
    filteredItems,
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
    topLevelItems,
  };
}
