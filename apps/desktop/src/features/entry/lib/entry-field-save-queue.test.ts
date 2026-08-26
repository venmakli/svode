import { expect, test } from "bun:test";
import {
  enqueueEntryFieldSave,
  recordEntryFieldSavePathAlias,
  resolveEntryFieldSavePath,
} from "./entry-field-save-queue";

test("enqueueEntryFieldSave serializes saves per key", async () => {
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
  expect(results).toEqual(["first", "second"]);
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});

test("enqueueEntryFieldSave continues after a rejected save", async () => {
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
  expect(results[0]?.status).toBe("rejected");
  expect(results[1]?.status).toBe("fulfilled");
  expect(events).toEqual(["first:start", "second:start"]);
});

test("resolveEntryFieldSavePath follows consecutive canonical renames", () => {
  const aliases = new Map<string, string>();
  recordEntryFieldSavePathAlias(aliases, "draft.md", "Первый.md");
  recordEntryFieldSavePathAlias(aliases, "Первый.md", "Финал.md");

  expect(resolveEntryFieldSavePath(aliases, "draft.md")).toBe("Финал.md");
  expect(resolveEntryFieldSavePath(aliases, "other.md")).toBe("other.md");

  recordEntryFieldSavePathAlias(aliases, "Финал.md", "draft.md");
  expect(resolveEntryFieldSavePath(aliases, "Финал.md")).toBe("draft.md");
  expect(resolveEntryFieldSavePath(aliases, "draft.md")).toBe("draft.md");
});

test("queued field save resolves the canonical path after an in-flight rename", async () => {
  const aliases = new Map<string, string>();
  const rename = (async () => {
    const canonicalPath = await enqueueEntryFieldSave(
      "field-save-test:path-handoff",
      async () => "Новое.md",
    );
    recordEntryFieldSavePathAlias(aliases, "Old.md", canonicalPath);
  })();
  const followingSave = enqueueEntryFieldSave(
    "field-save-test:path-handoff",
    async () => resolveEntryFieldSavePath(aliases, "Old.md"),
  );

  await rename;
  expect(await followingSave).toBe("Новое.md");
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
