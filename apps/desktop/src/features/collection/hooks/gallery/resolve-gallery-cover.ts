import type { Entry, EntryCover } from "@/features/entry";
import type { CollectionSchema } from "@/features/properties";
import { resolveEntryImageSource } from "../../api";
import type { GalleryResolvedCover } from "../../model/gallery-cover-types";

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
      src: resolveEntryImageSource({
        value,
        spacePath,
        entryPath: entry.path,
      }),
      position: 50,
    };
  }

  return null;
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
      src: resolveEntryImageSource({
        value: cover.path,
        spacePath,
        entryPath,
      }),
      position: cover.position ?? 50,
    };
  }
  return null;
}

function isRenderableImagePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(trimmed)) return true;
  if (/^(\.assets\/|\.\/|\.\.\/|\/)/.test(trimmed)) return true;
  return /\.(avif|gif|jpe?g|png|webp|svg)$/i.test(trimmed);
}
