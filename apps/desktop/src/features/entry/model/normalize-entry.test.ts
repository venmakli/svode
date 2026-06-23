import { expect, test } from "bun:test";
import { normalizeEntry } from "./normalize-entry";

type NormalizableEntry = Parameters<typeof normalizeEntry>[0];

test("normalizeEntry falls back unknown color covers to neutral", () => {
  const normalized = normalizeEntry(
    entry({
      cover: { type: "color", value: "custom" },
    }),
  );

  expect(normalized.meta.cover).toEqual({ type: "color", value: "neutral" });
});

test("normalizeEntry preserves image covers", () => {
  const cover = { type: "image" as const, path: "assets/cover.png", position: 35 };
  const normalized = normalizeEntry(entry({ cover }));

  expect(normalized.meta.cover).toEqual(cover);
});

function entry({
  cover = null,
}: {
  cover?:
    | { type: "color"; value: string }
    | { type: "image"; path: string; position?: number | null }
    | null;
} = {}): NormalizableEntry {
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
