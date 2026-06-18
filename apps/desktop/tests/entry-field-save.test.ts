import { expect, test } from "bun:test";
import type { Entry } from "../src/features/entry";
import {
  ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  enqueueEntryFieldSave,
  entryFieldSavePolicy,
  mergeSavedEntryField,
  patchEntryField,
  rollbackEntryField,
} from "../src/features/entry/model/field-save";
import { propertyFieldSavePolicy } from "../src/features/properties/model/save-policy";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    path: "tasks/item.md",
    body: "",
    meta: {
      id: "id",
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

test("entry system field policy separates text-like and action-like saves", () => {
  expect(entryFieldSavePolicy("title")).toEqual({
    mode: "debounced",
    delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(entryFieldSavePolicy("description")).toEqual({
    mode: "debounced",
    delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(entryFieldSavePolicy("icon")).toEqual({ mode: "immediate" });
  expect(entryFieldSavePolicy("cover")).toEqual({ mode: "immediate" });
});

test("property field policy keeps property type semantics in properties owner", () => {
  expect(propertyFieldSavePolicy({ type: "text" })).toEqual({
    mode: "debounced",
    delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(propertyFieldSavePolicy({ type: "number" })).toEqual({
    mode: "debounced",
    delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  });
  expect(propertyFieldSavePolicy({ type: "select" })).toEqual({
    mode: "immediate",
  });
  expect(propertyFieldSavePolicy({ type: "checkbox" })).toEqual({
    mode: "immediate",
  });
});

test("patchEntryField clears empty custom values but preserves false", () => {
  const base = entry({
    meta: {
      ...entry().meta,
      extra: {
        status: "Open",
        done: true,
      },
    },
  });

  expect(patchEntryField(base, "status", "").meta.extra).toEqual({
    done: true,
  });
  expect(patchEntryField(base, "done", false).meta.extra).toEqual({
    status: "Open",
    done: false,
  });
});

test("mergeSavedEntryField updates only the saved field", () => {
  const current = entry({
    meta: {
      ...entry().meta,
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
  const saved = entry({
    meta: {
      ...entry().meta,
      title: "Stale server title",
      icon: "S",
      description: "Stale server description",
      updated: "2026-06-18T00:00:02Z",
      extra: {
        status: "Done",
      },
    },
  });

  expect(mergeSavedEntryField(current, "icon", saved).meta).toMatchObject({
    title: "Local title",
    icon: "S",
    description: "Local description",
    updated: "2026-06-18T00:00:02Z",
    extra: {
      status: "Todo",
      priority: "High",
    },
  });

  expect(mergeSavedEntryField(current, "status", saved).meta.extra).toEqual({
    status: "Done",
    priority: "High",
  });
  expect(mergeSavedEntryField(current, "priority", saved).meta.extra).toEqual({
    status: "Todo",
  });
});

test("rollbackEntryField preserves newer metadata timestamp", () => {
  const current = entry({
    meta: {
      ...entry().meta,
      title: "Optimistic title",
      icon: "I",
      updated: "2026-06-18T00:00:03Z",
      extra: {
        status: "Done",
      },
    },
  });
  const previous = entry({
    meta: {
      ...entry().meta,
      title: "Previous title",
      icon: null,
      updated: "2026-06-18T00:00:00Z",
      extra: {
        status: "Todo",
      },
    },
  });

  expect(rollbackEntryField(current, "title", previous).meta).toMatchObject({
    title: "Previous title",
    icon: "I",
    updated: "2026-06-18T00:00:03Z",
    extra: {
      status: "Done",
    },
  });
});

test("enqueueEntryFieldSave serializes writes for the same entry", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueueEntryFieldSave("space:entry.md", async () => {
    events.push("first:start");
    await firstDone;
    events.push("first:end");
    return "first";
  });
  const second = enqueueEntryFieldSave("space:entry.md", async () => {
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
