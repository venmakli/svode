import { expect, test } from "bun:test";
import type { Entry } from "./types";
import {
  mergeSavedEntryField,
  patchEntryField,
  rollbackEntryField,
} from "./field-save";

test("patchEntryField updates system fields and extra fields", () => {
  const initial = entry({
    title: "Initial",
    description: "Draft",
    extra: { status: "todo" },
  });

  const titled = patchEntryField(initial, "title", "Renamed");
  expect(titled.meta.title).toBe("Renamed");
  expect(titled.meta.extra.status).toBe("todo");

  const described = patchEntryField(titled, "description", "   ");
  expect(described.meta.description).toBeNull();

  const withPriority = patchEntryField(described, "priority", "high");
  expect(withPriority.meta.extra.priority).toBe("high");

  const cleared = patchEntryField(withPriority, "priority", []);
  expect(Object.prototype.hasOwnProperty.call(cleared.meta.extra, "priority"))
    .toBe(false);
});

test("mergeSavedEntryField applies saved values and timestamp", () => {
  const current = entry({
    updated: "2026-06-20T00:00:00.000Z",
    extra: { status: "todo", owner: "current" },
  });
  const saved = entry({
    updated: "2026-06-21T00:00:00.000Z",
    extra: { owner: "saved" },
  });

  const mergedOwner = mergeSavedEntryField(current, "owner", saved);
  expect(mergedOwner.meta.updated).toBe("2026-06-21T00:00:00.000Z");
  expect(mergedOwner.meta.extra.owner).toBe("saved");
  expect(mergedOwner.meta.extra.status).toBe("todo");

  const mergedStatus = mergeSavedEntryField(current, "status", saved);
  expect(Object.prototype.hasOwnProperty.call(mergedStatus.meta.extra, "status"))
    .toBe(false);
});

test("rollbackEntryField restores previous field without rewinding updated", () => {
  const current = entry({
    title: "Optimistic",
    updated: "2026-06-22T00:00:00.000Z",
  });
  const previous = entry({
    title: "Previous",
    updated: "2026-06-20T00:00:00.000Z",
  });

  const rolledBack = rollbackEntryField(current, "title", previous);
  expect(rolledBack.meta.title).toBe("Previous");
  expect(rolledBack.meta.updated).toBe("2026-06-22T00:00:00.000Z");
});

function entry({
  title = "Title",
  description = null,
  updated = "2026-06-20T00:00:00.000Z",
  extra = {},
}: {
  title?: string;
  description?: string | null;
  updated?: string;
  extra?: Record<string, unknown>;
} = {}): Entry {
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
