import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { ReadmeWriteSession } from "./readme-write-session";
import type { Page } from "./types";

const page: Page = {
  path: "app/README.md",
  body: "",
  meta: { title: "app", icon: null, created: "", updated: "", extra: {} },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("header and body share creation; only latest drafts save and navigation waits for fields", async () => {
  const creation = deferred<Page>();
  const field = deferred<void>();
  let creates = 0;
  const saved: unknown[] = [];
  const session = new ReadmeWriteSession();
  session.configure({
    page: null,
    canWrite: true,
    create: () => {
      creates++;
      return creation.promise;
    },
    save: async (_, key, value) => {
      saved.push([key, value]);
      await field.promise;
    },
    flushFields: async () => {},
  });
  await session.updateField("description", "");
  expect(creates).toBe(0);
  const first = session.updateField("description", "a");
  const last = session.updateField("description", "abc");
  const icon = session.updateField("icon", "🚀");
  const body = session.createReadme();
  let navigated = false;
  const navigation = session.flush().then(() => {
    navigated = true;
  });
  expect(creates).toBe(1);
  creation.resolve(page);
  await body;
  await Promise.resolve();
  expect(saved).toEqual([
    ["description", "abc"],
    ["icon", "🚀"],
  ]);
  expect(navigated).toBe(false);
  field.resolve();
  await Promise.all([first, last, icon, navigation]);
  expect(navigated).toBe(true);
  expect(session.getSnapshot().drafts.size).toBe(0);
});

test("create failure retains draft, blocks navigation, and retries creation", async () => {
  let fail = true;
  let creates = 0;
  const session = new ReadmeWriteSession();
  session.configure({
    page: null,
    canWrite: true,
    create: async () => {
      creates++;
      if (fail) throw new Error("create failed");
      return page;
    },
    save: async () => {},
    flushFields: async () => {},
  });
  await assert.rejects(
    session.updateField("description", "keep me"),
    new RegExp("create failed"),
  );
  expect(session.getSnapshot().drafts.get("description")?.value).toBe(
    "keep me",
  );
  await assert.rejects(session.flush(), new RegExp("create failed"));
  fail = false;
  await session.retry();
  expect(creates).toBe(2);
  expect(session.getSnapshot().writeError).toBeNull();
});

test("field failure after creation retries the same README and latest value", async () => {
  let fail = true;
  let creates = 0;
  const values: unknown[] = [];
  const session = new ReadmeWriteSession();
  session.configure({
    page: null,
    canWrite: true,
    create: async () => {
      creates++;
      return page;
    },
    save: async (_, __, value) => {
      values.push(value);
      if (fail) throw new Error("field failed");
    },
    flushFields: async () => {},
  });
  await assert.rejects(
    session.updateField("icon", "🚀"),
    new RegExp("field failed"),
  );
  expect(creates).toBe(1);
  await assert.rejects(session.flush());
  fail = false;
  await session.retry();
  expect(creates).toBe(1);
  expect(values).toEqual(["🚀", "🚀"]);
  expect(session.getSnapshot().writeError).toBeNull();
});

test("disposed or newly blocked owner does not save metadata after late creation", async () => {
  for (const blocked of [false, true]) {
    const creation = deferred<Page>();
    let writes = 0;
    const session = new ReadmeWriteSession();
    const options = {
      page: null,
      canWrite: true,
      create: () => creation.promise,
      save: async () => {
        writes++;
      },
      flushFields: async () => {},
    };
    session.configure(options);
    const write = session.updateField("icon", "🚀");
    if (blocked) session.configure({ ...options, canWrite: false });
    else session.dispose();
    creation.resolve(page);
    await assert.rejects(write, new RegExp("not editable"));
    expect(writes).toBe(0);
  }
});

test("existing Page preserves field options and never creates", async () => {
  let creates = 0;
  const saved: unknown[] = [];
  const session = new ReadmeWriteSession();
  session.configure({
    page,
    canWrite: true,
    create: async () => {
      creates++;
      return page;
    },
    save: async (...args) => {
      saved.push(args);
    },
    flushFields: async () => {},
  });
  await session.updateField("title", "Renamed", { flush: true });
  expect(saved).toEqual([[page, "title", "Renamed", { flush: true }]]);
  expect(creates).toBe(0);
});

test("a new successful field must not hide another field's failed draft", async () => {
  let fail = true;
  const session = new ReadmeWriteSession();
  session.configure({
    page: null,
    canWrite: true,
    create: async () => {
      if (fail) throw new Error("create failed");
      return page;
    },
    save: async () => {},
    flushFields: async () => {},
  });
  await assert.rejects(session.updateField("description", "unsaved"));
  fail = false;
  await session.updateField("icon", "🚀");
  await assert.rejects(session.flush());
  expect(session.getSnapshot().drafts.get("description")?.value).toBe(
    "unsaved",
  );
  await session.retry();
  expect(session.getSnapshot().writeError).toBeNull();
});
