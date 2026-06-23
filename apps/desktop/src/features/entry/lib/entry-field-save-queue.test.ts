import { expect, test } from "bun:test";
import { enqueueEntryFieldSave } from "./entry-field-save-queue";

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
