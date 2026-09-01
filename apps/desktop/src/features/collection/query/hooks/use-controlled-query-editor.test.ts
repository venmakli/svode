import { expect, test } from "bun:test";

import {
  applyControlledQueryDraft,
  removeControlledQueryDraft,
  resolveControlledQueryEditorField,
} from "./use-controlled-query-editor";

test("controlled query orchestration inserts, replaces, and removes drafts immutably", () => {
  const original = ["first", "second"] as const;

  expect(
    applyControlledQueryDraft(original, { index: null, item: "third" }),
  ).toEqual(["first", "second", "third"]);
  expect(
    applyControlledQueryDraft(original, { index: 1, item: "updated" }),
  ).toEqual(["first", "updated"]);
  expect(
    removeControlledQueryDraft(original, { index: 0, item: "ignored" }),
  ).toEqual(["second"]);
  expect(original).toEqual(["first", "second"]);
});

test("controlled query orchestration ignores stale draft indexes", () => {
  const original = ["first"] as const;

  expect(applyControlledQueryDraft(original, { index: 4, item: "stale" })).toBe(
    original,
  );
  expect(
    removeControlledQueryDraft(original, { index: 4, item: "stale" }),
  ).toBe(original);
  expect(
    removeControlledQueryDraft(original, { index: null, item: "unsaved" }),
  ).toBe(original);
});

test("controlled query orchestration never falls back from an explicit unknown field", () => {
  const fields = [
    {
      createFilter: () => "filter",
      key: "name",
    },
    {
      createSort: () => "sort",
      key: "score",
    },
  ];

  expect(resolveControlledQueryEditorField(fields, "createFilter")?.key).toBe(
    "name",
  );
  expect(
    resolveControlledQueryEditorField(fields, "createFilter", "missing"),
  ).toBeNull();
  expect(
    resolveControlledQueryEditorField(fields, "createFilter", "score"),
  ).toBeNull();
});
