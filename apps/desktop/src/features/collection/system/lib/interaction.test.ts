import { expect, test } from "bun:test";

import {
  createSystemCollectionPresentationScope,
  createSystemCollectionDetailRequest,
  resolveSystemCollectionFocusIndex,
  runSystemCollectionCallback,
} from "./interaction";
import type { SystemCollectionPresentationDescriptor } from "../model/types";

test("list and card focus navigation stays within the snapshot", () => {
  expect(
    resolveSystemCollectionFocusIndex({
      currentIndex: 2,
      itemCount: 5,
      key: "ArrowDown",
      renderer: "list",
    }),
  ).toBe(3);
  expect(
    resolveSystemCollectionFocusIndex({
      cardColumns: 3,
      currentIndex: 4,
      itemCount: 8,
      key: "ArrowUp",
      renderer: "cards",
    }),
  ).toBe(1);
  expect(
    resolveSystemCollectionFocusIndex({
      currentIndex: 0,
      itemCount: 5,
      key: "ArrowUp",
      renderer: "list",
    }),
  ).toBeNull();
  expect(
    resolveSystemCollectionFocusIndex({
      currentIndex: 3,
      itemCount: 5,
      key: "Home",
      renderer: "cards",
    }),
  ).toBe(0);
});

test("callback rejection is returned as an explicit diagnostic result", async () => {
  const result = await runSystemCollectionCallback(
    () => Promise.reject(new Error("Repository is read-only")),
    "Fallback",
  );

  expect(result).toEqual({
    message: "Repository is read-only",
    ok: false,
  });
});

test("detail request receives stable instance, presentation, and row selection", () => {
  const descriptor: SystemCollectionPresentationDescriptor<{ id: string }> = {
    createDetailRequest: (row) => ({
      content: row.id,
      description: "Repository actor",
      title: "Actor",
    }),
    fields: [],
    getRowId: (row) => row.id,
    id: "contributors",
    label: "Contributors",
    layout: {
      getTitle: (row) => row.id,
      kind: "list",
      visibleFields: [],
    },
    query: {},
  };

  expect(
    createSystemCollectionDetailRequest({
      descriptor,
      instanceKey: "space:root:actors",
      row: { id: "person:one" },
      rowId: "person:one",
    })?.selection,
  ).toEqual({
    instanceKey: "space:root:actors",
    presentationId: "contributors",
    rowId: "person:one",
  });
});

test("non-error callback rejection uses the localized fallback", async () => {
  const result = await runSystemCollectionCallback(
    () => Promise.reject("failed"),
    "The action failed.",
  );

  expect(result).toEqual({
    message: "The action failed.",
    ok: false,
  });
});

test("presentation scope keeps instances and presentations isolated", () => {
  expect(
    createSystemCollectionPresentationScope("a:b", "c") ===
      createSystemCollectionPresentationScope("a", "b:c"),
  ).toBe(false);
  expect(
    createSystemCollectionPresentationScope("space:one", "actors") ===
      createSystemCollectionPresentationScope("space:two", "actors"),
  ).toBe(false);
});
