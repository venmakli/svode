import { convertFileSrc } from "@/platform/native/invoke";
import type { CSSProperties } from "react";
import type { CollectionView } from "@/features/collection/query";
import { normalizeEntryPath } from "@/features/collection/lib/utils";
import type { Entry, EntryCover } from "@/features/entry";
import type {
  CollectionSchema,
  Column,
  ColorName,
} from "@/features/properties";
import { entryCollectionPath } from "../table/utils";

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

export const COVER_GRADIENTS: Record<ColorName, string> = {
  neutral:
    "linear-gradient(135deg, oklch(0.94 0.02 255), oklch(0.88 0.03 255))",
  gray: "linear-gradient(135deg, oklch(0.93 0.02 250), oklch(0.84 0.03 250))",
  red: "linear-gradient(135deg, oklch(0.9 0.12 25), oklch(0.78 0.16 25))",
  orange: "linear-gradient(135deg, oklch(0.92 0.12 60), oklch(0.84 0.16 40))",
  yellow: "linear-gradient(135deg, oklch(0.93 0.12 95), oklch(0.86 0.16 85))",
  green: "linear-gradient(135deg, oklch(0.92 0.12 145), oklch(0.82 0.18 165))",
  blue: "linear-gradient(135deg, oklch(0.88 0.14 250), oklch(0.78 0.18 270))",
  purple: "linear-gradient(135deg, oklch(0.88 0.14 295), oklch(0.82 0.16 320))",
  pink: "linear-gradient(135deg, oklch(0.9 0.13 340), oklch(0.82 0.16 350))",
  brown: "linear-gradient(135deg, oklch(0.88 0.07 70), oklch(0.76 0.09 60))",
};

export type GalleryResolvedCover =
  | {
      kind: "color";
      value: ColorName;
    }
  | {
      kind: "image";
      src: string;
      position: number;
    }
  | {
      kind: "icon" | "initial";
      value: string;
    };

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

export function isFolderEntry(entry: Entry) {
  return normalizeEntryPath(entry.path).toLowerCase().endsWith("/readme.md");
}

export function resolveGalleryCover({
  entry,
  cardCover,
  schema,
  spacePath,
}: {
  entry: Entry;
  cardCover: string[];
  schema: CollectionSchema;
  spacePath: string;
}): GalleryResolvedCover | null {
  if (cardCover.length === 0) return null;

  for (const source of cardCover) {
    if (source === "cover") {
      const cover = resolveSystemCover(entry.meta.cover, spacePath, entry.path);
      if (cover) return cover;
      continue;
    }
    if (source === "icon" && entry.meta.icon) {
      return { kind: "icon", value: entry.meta.icon };
    }
    if (source === "title" && entry.meta.title.trim()) {
      return {
        kind: "initial",
        value: entry.meta.title.trim().slice(0, 1).toUpperCase(),
      };
    }

    const column = schema.columns.find((item) => item.name === source);
    if (!column || (column.type !== "url" && column.type !== "text")) {
      continue;
    }
    const value = entry.meta.extra?.[source];
    if (typeof value !== "string" || !isRenderableImagePath(value)) continue;
    return {
      kind: "image",
      src: resolveImageSource(value, spacePath, entry.path),
      position: 50,
    };
  }

  return null;
}

export function coverStyle(cover: GalleryResolvedCover | null): CSSProperties {
  if (!cover || cover.kind === "icon" || cover.kind === "initial") {
    return { background: COVER_GRADIENTS.neutral };
  }
  if (cover.kind === "color") {
    return {
      background: COVER_GRADIENTS[cover.value] ?? COVER_GRADIENTS.neutral,
    };
  }
  return { background: COVER_GRADIENTS.neutral };
}

function resolveSystemCover(
  cover: EntryCover | null | undefined,
  spacePath: string,
  entryPath: string,
): GalleryResolvedCover | null {
  if (!cover) return null;
  if (cover.type === "color") {
    return { kind: "color", value: cover.value };
  }
  if (cover.type === "image" && cover.path) {
    return {
      kind: "image",
      src: resolveImageSource(cover.path, spacePath, entryPath),
      position: cover.position ?? 50,
    };
  }
  return null;
}

function resolveImageSource(
  value: string,
  spacePath: string,
  entryPath: string,
) {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(value)) return value;
  if (value.startsWith("/")) return convertFileSrc(value);
  if (value.startsWith("./") || value.startsWith("../")) {
    return convertFileSrc(joinEntryPath(spacePath, entryPath, value));
  }
  return convertFileSrc(joinSpacePath(spacePath, value));
}

function joinSpacePath(spacePath: string, value: string) {
  const base = spacePath.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${base}/${rel}`;
}

function joinEntryPath(spacePath: string, entryPath: string, value: string) {
  const normalizedEntry = entryPath.replace(/\\/g, "/");
  const parent = normalizedEntry.includes("/")
    ? normalizedEntry.slice(0, normalizedEntry.lastIndexOf("/"))
    : "";
  return normalizePath(
    joinSpacePath(spacePath, `${parent}/${value.replace(/\\/g, "/")}`),
  );
}

function normalizePath(path: string) {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function isRenderableImagePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(trimmed)) return true;
  if (/^(\.assets\/|\.\/|\.\.\/|\/)/.test(trimmed)) return true;
  return /\.(avif|gif|jpe?g|png|webp|svg)$/i.test(trimmed);
}
