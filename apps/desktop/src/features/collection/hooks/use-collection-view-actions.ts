import { arrayMove } from "@dnd-kit/sortable";
import type { Dispatch, SetStateAction } from "react";
import type { CollectionSchema } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import {
  addCollectionView,
  deleteCollectionView,
  duplicateCollectionView,
  lastCollectionView,
  renameCollectionView,
  reorderCollectionViews,
  updateCollectionView,
} from "../api";
import {
  nextTableViewName,
  nextViewName,
  viewType,
} from "../lib/utils";
import type { ActiveTab, SettingsPane } from "../model";
import type { CollectionView, ViewType } from "../query";

function viewTypeDefaultName(type: ViewType) {
  const names: Record<ViewType, string> = {
    table: "Table",
    board: "Board",
    calendar: "Calendar",
    list: "List",
    gallery: "Gallery",
  };
  return names[type];
}

export function useCollectionViewActions({
  schema,
  setSchema,
  views,
  activeView,
  renameValue,
  collectionPath,
  spacePath,
  projectPath,
  hasReadme,
  selectTab,
  setSettingsPane,
  setSettingsOpen,
  setDeleteOpen,
}: {
  schema: CollectionSchema | null;
  setSchema: Dispatch<SetStateAction<CollectionSchema | null>>;
  views: CollectionView[];
  activeView: CollectionView | null;
  renameValue: string;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  hasReadme: boolean;
  selectTab: (next: ActiveTab) => void;
  setSettingsPane: Dispatch<SetStateAction<SettingsPane>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteOpen: Dispatch<SetStateAction<boolean>>;
}) {
  function autoConfigForType(nextType: ViewType) {
    if (!schema) return {};
    if (nextType === "board") {
      const groupBy =
        schema.columns.find((column) => column.type === "status")?.name ??
        schema.columns.find((column) => column.type === "select")?.name ??
        schema.columns.find(
          (column) => column.type === "actor" && !column.multiple,
        )?.name ??
        null;
      return groupBy
        ? { type: nextType, group_by: groupBy }
        : { type: nextType, group_by: null };
    }
    if (nextType === "calendar") {
      const dateField =
        schema.columns.find((column) => column.type === "date")?.name ?? null;
      return dateField
        ? { type: nextType, date_field: dateField }
        : { type: nextType, date_field: null };
    }
    if (nextType === "gallery") {
      return {
        type: nextType,
        card_cover: ["cover", "icon", "title"],
        cover_fit: "cover",
        cover_aspect: "16/9",
        size: "medium",
      };
    }
    return { type: nextType };
  }

  async function addView(type: ViewType = "table") {
    if (!schema) return;
    const defaultFields = [
      "title",
      ...schema.columns.map((column) => column.name),
    ];
    const view = {
      name:
        type === "table"
          ? nextTableViewName(views)
          : nextViewName(views, viewTypeDefaultName(type)),
      visible_fields: defaultFields,
      ...autoConfigForType(type),
    };
    const next = await addCollectionView({
      spacePath,
      collectionPath,
      view,
      position: null,
      projectPath,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    const created = lastCollectionView(normalized);
    if (created) {
      selectTab(created.name);
      setSettingsPane("main");
      setSettingsOpen(true);
    }
  }

  async function updateView(
    viewNameToUpdate: string,
    patch: Record<string, unknown>,
  ) {
    const next = await updateCollectionView({
      spacePath,
      collectionPath,
      viewName: viewNameToUpdate,
      patch,
      projectPath,
    });
    setSchema(normalizeSchema(next));
  }

  async function renameActiveView() {
    if (!activeView) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName === activeView.name) return;
    const next = await renameCollectionView({
      spacePath,
      collectionPath,
      oldName: activeView.name,
      newName: nextName,
      projectPath,
    });
    setSchema(normalizeSchema(next));
    selectTab(nextName);
  }

  async function duplicateActiveView() {
    if (!activeView) return;
    const next = await duplicateCollectionView({
      spacePath,
      collectionPath,
      viewName: activeView.name,
      newName: `${activeView.name} copy`,
      projectPath,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    const created = lastCollectionView(normalized);
    if (created) selectTab(created.name);
  }

  async function deleteActiveView() {
    if (!activeView) return;
    const next = await deleteCollectionView({
      spacePath,
      collectionPath,
      viewName: activeView.name,
      projectPath,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    selectTab(
      hasReadme
        ? "document"
        : (((normalized.views ?? []) as CollectionView[])[0]?.name ??
            "document"),
    );
    setDeleteOpen(false);
  }

  async function reorder(nextOrder: string[]) {
    const next = await reorderCollectionViews({
      spacePath,
      collectionPath,
      newOrder: nextOrder,
      projectPath,
    });
    setSchema(normalizeSchema(next));
  }

  async function moveActive(offset: number) {
    if (!activeView) return;
    const index = views.findIndex((view) => view.name === activeView.name);
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= views.length) return;
    await reorder(
      arrayMove(
        views.map((view) => view.name),
        index,
        nextIndex,
      ),
    );
  }

  function createEntryFocusTarget() {
    if (!activeView) return null;
    return viewType(activeView);
  }

  return {
    addView,
    autoConfigForType,
    updateView,
    renameActiveView,
    duplicateActiveView,
    deleteActiveView,
    reorder,
    moveActive,
    createEntryFocusTarget,
  };
}
