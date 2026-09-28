import { expect, test } from "bun:test";
import {
  isPageSchemaEvent,
  isPageSourceEvent,
  mergeExternalPageMeta,
} from "./external-refresh";
import type { Page } from "./types";

function page(meta: Partial<Page["meta"]> = {}, body = "Body"): Page {
  return {
    path: "tasks/Item2.md",
    body,
    source_version: "v1",
    meta: {
      title: "Item2",
      icon: null,
      description: null,
      cover: null,
      created: "2026-09-20",
      updated: "2026-09-20",
      extra: { Note: "old", Done: false, Owner: [] },
      ...meta,
    },
  };
}

test("another writer's metadata replaces the shown values but not the body", () => {
  const current = page();
  const source = page(
    {
      title: "Renamed",
      icon: "🌿",
      description: "External",
      cover: { type: "color", value: "blue" },
      updated: "2026-09-28",
      extra: { Note: "old", Done: true, Owner: ["Ada.md"] },
    },
    "External body",
  );

  const merged = mergeExternalPageMeta(current, source, new Set());

  expect(merged.meta).toEqual(source.meta);
  expect(merged.body).toBe("Body");
  expect(merged.source_version).toBe("v1");
  expect(merged.path).toBe(current.path);
});

test("fields with local work keep their value while the others refresh", () => {
  const current = page({
    description: "Mine",
    extra: { Note: "draft", Done: false },
  });
  const source = page({
    description: "Theirs",
    icon: "🌿",
    extra: { Note: "theirs", Done: true, Owner: ["Ada.md"] },
  });

  const merged = mergeExternalPageMeta(
    current,
    source,
    new Set(["description", "Note", "Missing"]),
  );

  expect(merged.meta.description).toBe("Mine");
  expect(merged.meta.icon).toBe("🌿");
  expect(merged.meta.extra).toEqual({
    Note: "draft",
    Done: true,
    Owner: ["Ada.md"],
  });
});

test("a field removed by another writer disappears unless it is local", () => {
  const current = page({ extra: { Note: "old", Done: false } });
  const source = page({ extra: { Note: "old" } });

  expect(mergeExternalPageMeta(current, source, new Set()).meta.extra).toEqual({
    Note: "old",
  });
  expect(
    mergeExternalPageMeta(current, source, new Set(["Done"])).meta.extra,
  ).toEqual({ Note: "old", Done: false });
});

test("an echo of the shown file keeps the same Page and value identities", () => {
  const current = page({ cover: { type: "color", value: "red" } });
  const echo = structuredClone(current);

  expect(mergeExternalPageMeta(current, echo, new Set())).toBe(current);

  const changed = mergeExternalPageMeta(
    current,
    { ...echo, meta: { ...echo.meta, updated: "2026-09-28" } },
    new Set(),
  );
  expect(changed === current).toBe(false);
  expect(changed.meta.cover).toBe(current.meta.cover);
  expect(changed.meta.extra).toBe(current.meta.extra);
  expect(changed.meta.extra.Owner).toBe(current.meta.extra.Owner);
});

test("only the Page file and its owning schemas are refresh events", () => {
  expect(isPageSourceEvent("tasks/Item2.md", "tasks/Item2.md")).toBe(true);
  expect(isPageSourceEvent("tasks\\Item2.md", "tasks/Item2.md")).toBe(true);
  expect(isPageSourceEvent("tasks/Item3.md", "tasks/Item2.md")).toBe(false);

  expect(isPageSchemaEvent("tasks/schema.yaml", "tasks/Item2.md")).toBe(true);
  expect(isPageSchemaEvent("schema.yaml", "tasks/Item2.md")).toBe(true);
  expect(isPageSchemaEvent("tasks/schema.yaml", "tasks/Item2/README.md")).toBe(
    true,
  );
  expect(isPageSchemaEvent("people/schema.yaml", "tasks/Item2.md")).toBe(false);
  expect(isPageSchemaEvent("tasks/Item2/schema.yaml", "tasks/Item2.md")).toBe(
    false,
  );
  expect(isPageSchemaEvent("tasks/Item3.md", "tasks/Item2.md")).toBe(false);
});
