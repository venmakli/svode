import { expect, test } from "bun:test";
import { normalizePage } from "./normalize-page";

type NormalizablePage = Parameters<typeof normalizePage>[0];

test("normalizePage falls back unknown color covers to neutral", () => {
  const normalized = normalizePage(
    page({
      cover: { type: "color", value: "custom" },
    }),
  );

  expect(normalized.meta.cover).toEqual({ type: "color", value: "neutral" });
});

test("normalizePage preserves image covers", () => {
  const cover = { type: "image" as const, path: "assets/cover.png", position: 35 };
  const normalized = normalizePage(page({ cover }));

  expect(normalized.meta.cover).toEqual(cover);
});

function page({
  cover = null,
}: {
  cover?:
    | { type: "color"; value: string }
    | { type: "image"; path: string; position?: number | null }
    | null;
} = {}): NormalizablePage {
  return {
    path: "docs/page.md",
    body: "",
    meta: {
      title: "Title",
      icon: null,
      description: null,
      cover,
      created: "2026-06-19T00:00:00.000Z",
      updated: "2026-06-20T00:00:00.000Z",
      extra: {},
    },
  };
}
