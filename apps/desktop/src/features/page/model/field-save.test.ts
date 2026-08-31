import { expect, test } from "bun:test";
import type { Page } from "./types";
import {
  mergeSavedPageField,
  mergeSavedPageFieldResult,
  patchPageField,
  rollbackPageField,
} from "./field-save";

test("patchPageField updates system fields and extra fields", () => {
  const initial = page({
    title: "Initial",
    description: "Draft",
    extra: { status: "todo" },
  });

  const titled = patchPageField(initial, "title", "Renamed");
  expect(titled.meta.title).toBe("Renamed");
  expect(titled.meta.extra.status).toBe("todo");

  const described = patchPageField(titled, "description", "   ");
  expect(described.meta.description).toBeNull();

  const withPriority = patchPageField(described, "priority", "high");
  expect(withPriority.meta.extra.priority).toBe("high");

  const cleared = patchPageField(withPriority, "priority", []);
  expect(Object.prototype.hasOwnProperty.call(cleared.meta.extra, "priority"))
    .toBe(false);
});

test("mergeSavedPageField applies saved values and timestamp", () => {
  const current = page({
    updated: "2026-06-20T00:00:00.000Z",
    extra: { status: "todo", owner: "current" },
  });
  const saved = page({
    updated: "2026-06-21T00:00:00.000Z",
    extra: { owner: "saved" },
  });

  const mergedOwner = mergeSavedPageField(current, "owner", saved);
  expect(mergedOwner.meta.updated).toBe("2026-06-21T00:00:00.000Z");
  expect(mergedOwner.meta.extra.owner).toBe("saved");
  expect(mergedOwner.meta.extra.status).toBe("todo");

  const mergedStatus = mergeSavedPageField(current, "status", saved);
  expect(Object.prototype.hasOwnProperty.call(mergedStatus.meta.extra, "status"))
    .toBe(false);
});

test("mergeSavedPageFieldResult applies backend path unless editor coordination owns it", () => {
  const current = { ...page(), path: "Без названия/README.md" };
  const saved = {
    ...page({ title: "Проекты команды" }),
    path: "Проекты команды/README.md",
  };

  expect(
    mergeSavedPageFieldResult(current, "title", saved, false).path,
  ).toBe("Проекты команды/README.md");
  expect(mergeSavedPageFieldResult(current, "title", saved, true).path).toBe(
    "Без названия/README.md",
  );
});

test("rollbackPageField restores previous field without rewinding updated", () => {
  const current = page({
    title: "Optimistic",
    updated: "2026-06-22T00:00:00.000Z",
  });
  const previous = page({
    title: "Previous",
    updated: "2026-06-20T00:00:00.000Z",
  });

  const rolledBack = rollbackPageField(current, "title", previous);
  expect(rolledBack.meta.title).toBe("Previous");
  expect(rolledBack.meta.updated).toBe("2026-06-22T00:00:00.000Z");
});

function page({
  title = "Title",
  description = null,
  updated = "2026-06-20T00:00:00.000Z",
  extra = {},
}: {
  title?: string;
  description?: string | null;
  updated?: string;
  extra?: Record<string, unknown>;
} = {}): Page {
  return {
    path: "docs/page.md",
    body: "",
    meta: {
      title,
      icon: null,
      description,
      cover: null,
      created: "2026-06-19T00:00:00.000Z",
      updated,
      extra,
    },
  };
}
