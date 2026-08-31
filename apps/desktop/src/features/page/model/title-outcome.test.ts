import { expect, test } from "bun:test";
import type { Page } from "./types";
import { applyPageTitleOutcome } from "./title-outcome";

test("title outcome changes identity without replacing live body and metadata", () => {
  const current = {
    path: "Untitled.md",
    meta: {
      title: "Draft title",
      description: "Local description",
      updated: "before",
      extra: { status: "draft" },
    },
    body: [{ type: "p", children: [{ text: "Live body" }] }],
    warnings: [],
  } as unknown as Page;
  const saved = {
    ...current,
    path: "Final.md",
    meta: {
      ...current.meta,
      title: "Final",
      description: "Stale description",
      updated: "after",
    },
  };

  const result = applyPageTitleOutcome(current, saved);

  expect(result.path).toBe("Final.md");
  expect(result.meta.title).toBe("Final");
  expect(result.meta.updated).toBe("after");
  expect(result.meta.description).toBe("Local description");
  expect(result.meta.extra).toEqual({ status: "draft" });
  expect(result.body).toBe(current.body);
});
