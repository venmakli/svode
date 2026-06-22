import type { Entry } from "./types";
import {
  enqueueEntryFieldSave,
  mergeSavedEntryField,
  patchEntryField,
  rollbackEntryField,
} from "./field-save";

await run("patchEntryField updates system fields and extra fields", () => {
  const initial = entry({
    title: "Initial",
    description: "Draft",
    extra: { status: "todo" },
  });

  const titled = patchEntryField(initial, "title", "Renamed");
  assert(titled.meta.title === "Renamed", "title should be patched");
  assert(
    titled.meta.extra.status === "todo",
    "system field patches should preserve extra fields",
  );

  const described = patchEntryField(titled, "description", "   ");
  assert(
    described.meta.description === null,
    "blank descriptions should normalize to null",
  );

  const withPriority = patchEntryField(described, "priority", "high");
  assert(
    withPriority.meta.extra.priority === "high",
    "custom fields should patch meta.extra",
  );

  const cleared = patchEntryField(withPriority, "priority", []);
  assert(
    !Object.prototype.hasOwnProperty.call(cleared.meta.extra, "priority"),
    "cleared custom values should be removed from meta.extra",
  );
});

await run("mergeSavedEntryField applies saved values and timestamp", () => {
  const current = entry({
    updated: "2026-06-20T00:00:00.000Z",
    extra: { status: "todo", owner: "current" },
  });
  const saved = entry({
    updated: "2026-06-21T00:00:00.000Z",
    extra: { owner: "saved" },
  });

  const mergedOwner = mergeSavedEntryField(current, "owner", saved);
  assert(
    mergedOwner.meta.updated === "2026-06-21T00:00:00.000Z",
    "saved timestamp should win",
  );
  assert(
    mergedOwner.meta.extra.owner === "saved",
    "saved custom field value should win",
  );
  assert(
    mergedOwner.meta.extra.status === "todo",
    "unrelated custom fields should be preserved",
  );

  const mergedStatus = mergeSavedEntryField(current, "status", saved);
  assert(
    !Object.prototype.hasOwnProperty.call(mergedStatus.meta.extra, "status"),
    "missing saved custom field should delete the current field",
  );
});

await run("rollbackEntryField restores previous field without rewinding updated", () => {
  const current = entry({
    title: "Optimistic",
    updated: "2026-06-22T00:00:00.000Z",
  });
  const previous = entry({
    title: "Previous",
    updated: "2026-06-20T00:00:00.000Z",
  });

  const rolledBack = rollbackEntryField(current, "title", previous);
  assert(
    rolledBack.meta.title === "Previous",
    "previous field should be restored",
  );
  assert(
    rolledBack.meta.updated === "2026-06-22T00:00:00.000Z",
    "current timestamp should be preserved",
  );
});

await run("enqueueEntryFieldSave serializes saves per key", async () => {
  const events: string[] = [];

  const first = enqueueEntryFieldSave("field-save-test:serial", async () => {
    events.push("first:start");
    await delay(5);
    events.push("first:end");
    return "first";
  });
  const second = enqueueEntryFieldSave("field-save-test:serial", async () => {
    events.push("second:start");
    return "second";
  });

  const results = await Promise.all([first, second]);
  assert(results.join(",") === "first,second", "queued results should resolve");
  assert(
    events.join(",") === "first:start,first:end,second:start",
    "second task should start after first task completes",
  );
});

await run("enqueueEntryFieldSave continues after a rejected save", async () => {
  const events: string[] = [];

  const first = enqueueEntryFieldSave("field-save-test:rejection", async () => {
    events.push("first:start");
    throw new Error("expected failure");
  });
  const second = enqueueEntryFieldSave("field-save-test:rejection", async () => {
    events.push("second:start");
    return "second";
  });

  const results = await Promise.allSettled([first, second]);
  assert(results[0]?.status === "rejected", "first task should reject");
  assert(results[1]?.status === "fulfilled", "second task should still run");
  assert(events.join(",") === "first:start,second:start", "queue should recover");
});

async function run(name: string, test: () => void | Promise<void>) {
  await test();
  console.log(`ok - ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
