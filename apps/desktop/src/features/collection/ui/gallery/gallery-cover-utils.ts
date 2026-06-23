import type { CSSProperties } from "react";
import type { Entry, EntryCover } from "@/features/entry";
import type { CollectionSchema, ColorName } from "@/features/properties";
import { resolveEntryImageSource } from "../../api";

const COVER_GRADIENTS: Record<ColorName, string> = {
  neutral:
    "linear-gradient(135deg, oklch(0.94 0.02 255), oklch(0.88 0.03 255))",
  gray: "linear-gradient(135deg, oklch(0.93 0.02 250), oklch(0.84 0.03 250))",
  red: "linear-gradient(135deg, oklch(0.9 0.12 25), oklch(0.78 0.16 25))",
  orange: "linear-gradient(135deg, oklch(0.92 0.12 60), oklch(0.84 0.16 40))",
  yellow: "linear-gradient(135deg, oklch(0.93 0.12 95), oklch(0.86 0.16 85))",
  green: "linear-gradient(135deg, oklch(0.92 0.12 145), oklch(0.82 0.18 165))",
  blue: "linear-gradient(135deg, oklch(0.88 0.14 250), oklch(0.78 0.18 270))",
  purple:
    "linear-gradient(135deg, oklch(0.88 0.14 295), oklch(0.82 0.16 320))",
  pink: "linear-gradient(135deg, oklch(0.9 0.13 340), oklch(0.82 0.16 350))",
  brown: "linear-gradient(135deg, oklch(0.88 0.07 70), oklch(0.76 0.09 60))",
};

type GalleryResolvedCover =
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
