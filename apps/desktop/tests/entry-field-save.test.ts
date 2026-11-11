import { expect, test } from "bun:test";
import { propertyFieldSavePolicy, type Page } from "../src/features/page";
import {
  PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  pageFieldSavePolicy,
} from "../src/features/page/field-save";
import { enqueuePageFieldSave } from "../src/features/page/lib/page-field-save-queue";
import {
  mergeSavedPageField,
  patchPageField,
  rollbackPageField,
} from "../src/features/page/model/field-save";

function page(overrides: Partial<Page> = {}): Page {
  return {
    path: "tasks/item.md",
    body: "",
    meta: {
      title: "Task",
      icon: null,
      description: null,
      cover: null,
      created: "2026-06-18T00:00:00Z",
      updated: "2026-06-18T00:00:00Z",
      extra: {},
    },
    ...overrides,
  };
}

test("Page system field policy separates text-like and action-like saves", () => {
  expect(pageFieldSavePolicy("title")).toEqual({
    mode: "debounced",
    delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(pageFieldSavePolicy("description")).toEqual({
    mode: "debounced",
    delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(pageFieldSavePolicy("icon")).toEqual({ mode: "immediate" });
  expect(pageFieldSavePolicy("cover")).toEqual({ mode: "immediate" });
});

test("property field policy keeps property type semantics in properties owner", () => {
  expect(propertyFieldSavePolicy({ type: "text" })).toEqual({
    mode: "debounced",
    delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(propertyFieldSavePolicy({ type: "number" })).toEqual({
    mode: "debounced",
    delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(propertyFieldSavePolicy({ type: "select" })).toEqual({
    mode: "immediate",
  });
  expect(propertyFieldSavePolicy({ type: "boolean" })).toEqual({
    mode: "immediate",
  });
});

test("patchPageField clears empty custom values but preserves false", () => {
  const base = page({
    meta: {
      ...page().meta,
      extra: {
        status: "Open",
        done: true,
      },
    },
  });

  expect(patchPageField(base, "status", "").meta.extra).toEqual({
    done: true,
  });
  expect(patchPageField(base, "done", false).meta.extra).toEqual({
    status: "Open",
    done: false,
  });
});

test("mergeSavedPageField updates only the saved field", () => {
  const current = page({
    meta: {
      ...page().meta,
      title: "Local title",
      icon: "L",
      description: "Local description",
      updated: "2026-06-18T00:00:01Z",
      extra: {
        status: "Todo",
        priority: "High",
      },
    },
  });
  const saved = page({
    meta: {
      ...page().meta,
      title: "Stale server title",
      icon: "S",
      description: "Stale server description",
      updated: "2026-06-18T00:00:02Z",
      extra: {
        status: "Done",
      },
    },
  });

  expect(mergeSavedPageField(current, "icon", saved).meta).toMatchObject({
    title: "Local title",
    icon: "S",
    description: "Local description",
    updated: "2026-06-18T00:00:02Z",
    extra: {
      status: "Todo",
      priority: "High",
    },
  });

  expect(mergeSavedPageField(current, "status", saved).meta.extra).toEqual({
    status: "Done",
    priority: "High",
  });
  expect(mergeSavedPageField(current, "priority", saved).meta.extra).toEqual({
    status: "Todo",
  });
});

test("rollbackPageField preserves newer metadata timestamp", () => {
  const current = page({
    meta: {
      ...page().meta,
      title: "Optimistic title",
      icon: "I",
      updated: "2026-06-18T00:00:03Z",
      extra: {
        status: "Done",
      },
    },
  });
  const previous = page({
    meta: {
      ...page().meta,
      title: "Previous title",
      icon: null,
      updated: "2026-06-18T00:00:00Z",
      extra: {
        status: "Todo",
      },
    },
  });

  expect(rollbackPageField(current, "title", previous).meta).toMatchObject({
    title: "Previous title",
    icon: "I",
    updated: "2026-06-18T00:00:03Z",
    extra: {
      status: "Done",
    },
  });
});

test("enqueuePageFieldSave serializes writes for the same Page", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueuePageFieldSave("space:page.md", async () => {
    events.push("first:start");
    await firstDone;
    events.push("first:end");
    return "first";
  });
  const second = enqueuePageFieldSave("space:page.md", async () => {
    events.push("second:start");
    return "second";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["first:start"]);
  releaseFirst();

  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});
