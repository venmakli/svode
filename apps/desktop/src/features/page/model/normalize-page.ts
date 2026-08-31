import type { CoverColorName, Page, PageCover } from "./types";

type PageCoverLike =
  | { type: "color"; value: string }
  | { type: "image"; path: string; position?: number | null };

type PageLike = Omit<Page, "meta"> & {
  meta: Omit<Page["meta"], "cover"> & {
    cover?: PageCoverLike | null;
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

export function normalizePage(page: PageLike): Page {
  return {
    ...page,
    meta: {
      ...page.meta,
      cover: normalizePageCover(page.meta.cover),
    },
  };
}

export function normalizePages(pages: PageLike[]): Page[] {
  return pages.map(normalizePage);
}

export function normalizePageCover(
  cover: PageCoverLike | null | undefined,
): PageCover | null | undefined {
  if (cover == null) return cover;
  if (cover.type === "image") return cover;
  return {
    type: "color",
    value: COVER_COLOR_NAMES.has(cover.value as CoverColorName)
      ? (cover.value as CoverColorName)
      : "neutral",
  };
}
