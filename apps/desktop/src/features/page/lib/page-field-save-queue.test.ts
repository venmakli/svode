import { expect, test } from "bun:test";
import {
  enqueuePageFieldSave,
  recordPageFieldSavePathAlias,
  resolvePageFieldSavePath,
} from "./page-field-save-queue";

test("enqueuePageFieldSave serializes saves per key", async () => {
  const events: string[] = [];

  const first = enqueuePageFieldSave("field-save-test:serial", async () => {
    events.push("first:start");
    await delay(5);
    events.push("first:end");
    return "first";
  });
  const second = enqueuePageFieldSave("field-save-test:serial", async () => {
    events.push("second:start");
    return "second";
  });

  const results = await Promise.all([first, second]);
  expect(results).toEqual(["first", "second"]);
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});

test("enqueuePageFieldSave continues after a rejected save", async () => {
  const events: string[] = [];

  const first = enqueuePageFieldSave("field-save-test:rejection", async () => {
    events.push("first:start");
    throw new Error("expected failure");
  });
  const second = enqueuePageFieldSave("field-save-test:rejection", async () => {
    events.push("second:start");
    return "second";
  });

  const results = await Promise.allSettled([first, second]);
  expect(results[0]?.status).toBe("rejected");
  expect(results[1]?.status).toBe("fulfilled");
  expect(events).toEqual(["first:start", "second:start"]);
});

test("resolvePageFieldSavePath follows consecutive canonical renames", () => {
  const aliases = new Map<string, string>();
  recordPageFieldSavePathAlias(aliases, "draft.md", "Первый.md");
  recordPageFieldSavePathAlias(aliases, "Первый.md", "Финал.md");

  expect(resolvePageFieldSavePath(aliases, "draft.md")).toBe("Финал.md");
  expect(resolvePageFieldSavePath(aliases, "other.md")).toBe("other.md");

  recordPageFieldSavePathAlias(aliases, "Финал.md", "draft.md");
  expect(resolvePageFieldSavePath(aliases, "Финал.md")).toBe("draft.md");
  expect(resolvePageFieldSavePath(aliases, "draft.md")).toBe("draft.md");
});

test("queued field save resolves the canonical path after an in-flight rename", async () => {
  const aliases = new Map<string, string>();
  const rename = (async () => {
    const canonicalPath = await enqueuePageFieldSave(
      "field-save-test:path-handoff",
      async () => "Новое.md",
    );
    recordPageFieldSavePathAlias(aliases, "Old.md", canonicalPath);
  })();
  const followingSave = enqueuePageFieldSave(
    "field-save-test:path-handoff",
    async () => resolvePageFieldSavePath(aliases, "Old.md"),
  );

  await rename;
  expect(await followingSave).toBe("Новое.md");
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
