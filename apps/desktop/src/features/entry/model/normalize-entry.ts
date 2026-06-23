import type { CoverColorName, Entry, EntryCover } from "./types";

type EntryCoverLike =
  | { type: "color"; value: string }
  | { type: "image"; path: string; position?: number | null };

type EntryLike = Omit<Entry, "meta"> & {
  meta: Omit<Entry["meta"], "cover"> & {
    cover?: EntryCoverLike | null;
  };
};

const COVER_COLOR_NAMES = new Set<CoverColorName>([
  "neutral",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
]);

export function normalizeEntry(entry: EntryLike): Entry {
  return {
    ...entry,
    meta: {
      ...entry.meta,
      cover: normalizeEntryCover(entry.meta.cover),
    },
  };
}

export function normalizeEntries(entries: EntryLike[]): Entry[] {
  return entries.map(normalizeEntry);
}

export function normalizeEntryCover(
  cover: EntryCoverLike | null | undefined,
): EntryCover | null | undefined {
  if (cover == null) return cover;
  if (cover.type === "image") return cover;
  return {
    type: "color",
    value: COVER_COLOR_NAMES.has(cover.value as CoverColorName)
      ? (cover.value as CoverColorName)
      : "neutral",
  };
}
