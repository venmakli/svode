import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type { CollectionSchema, Column } from "@/features/properties";
import { entryCollectionPath, isFolderEntry } from "./entry-tree";

const GALLERY_BODY_SYSTEM_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "cover",
]);

const SYSTEM_META_COLUMNS: Record<string, Column> = {
  created: { name: "created", type: "date", display: "medium" },
  updated: { name: "updated", type: "date", display: "medium" },
};

export const GALLERY_CARD_WIDTH = {
  small: 160,
  medium: 240,
  large: 320,
};

export { isFolderEntry };

export function galleryCardWidth(view: CollectionView) {
  const size = String(view.size ?? "medium");
  return size === "small"
    ? GALLERY_CARD_WIDTH.small
    : size === "large"
      ? GALLERY_CARD_WIDTH.large
      : GALLERY_CARD_WIDTH.medium;
}

export function galleryCoverAspect(view: CollectionView) {
  const aspect = String(view.cover_aspect ?? "16/9").replace(":", "/");
  if (aspect === "4/3" || aspect === "1/1" || aspect === "3/4") {
    return aspect;
  }
  return "16/9";
}

export function galleryCoverFit(view: CollectionView): "cover" | "contain" {
  return view.cover_fit === "contain" ? "contain" : "cover";
}

export function galleryCoverRatio(aspect: string) {
  const [width, height] = aspect.split("/").map(Number);
  return width && height ? width / height : 16 / 9;
}

export function galleryCardCover(view: CollectionView) {
  if (Array.isArray(view.card_cover)) {
    return (view.card_cover as unknown[]).map(String);
  }
  return ["cover", "icon", "title"];
}

export function normalizeGalleryCardFields(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured = Array.isArray(view.card_fields)
    ? (view.card_fields as unknown[]).map(String)
    : [
        "title",
        "description",
        ...schema.columns.slice(0, 4).map((column) => column.name),
      ];
  const allowed = new Set([
    "title",
    "icon",
    "description",
    "created",
    "updated",
    ...schema.columns.map((column) => column.name),
  ]);
  return configured.filter((field) => allowed.has(field));
}

export function galleryMetaColumns(fields: string[], schema: CollectionSchema) {
  return fields
    .filter((field) => !GALLERY_BODY_SYSTEM_FIELDS.has(field))
    .map(
      (field) =>
        SYSTEM_META_COLUMNS[field] ??
        schema.columns.find((column) => column.name === field),
    )
    .filter((column): column is Column => Boolean(column));
}

export function isNestedCollectionEntry(
  entry: Entry,
  nestedCollectionPaths: Set<string>,
) {
  return nestedCollectionPaths.has(entryCollectionPath(entry));
}
