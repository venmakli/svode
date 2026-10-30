import { expect, test } from "bun:test";
import {
  trackOwnContentDeletion,
  trackOwnContentRelocation,
  watchOwnPathChange,
} from "./own-path-change";

test("a running or finished own deletion removes the Page it covers", async () => {
  const page = watchOwnPathChange("/space", "Notes/Item.md");
  const sibling = watchOwnPathChange("/space", "Notes2/Item.md");
  const otherSpace = watchOwnPathChange("/other", "Notes/Item.md");
  try {
    let running = false;
    await trackOwnContentDeletion(
      { spacePath: "/space/", path: "Notes" },
      async () => {
        running = page.changedHere();
      },
    );
    expect(running).toBe(true);
    expect(page.changedHere()).toBe(true);
    expect(sibling.changedHere()).toBe(false);
    expect(otherSpace.changedHere()).toBe(false);
  } finally {
    page.stop();
    sibling.stop();
    otherSpace.stop();
  }
});

test("a nested README deletion removes its directory, a root README only itself", async () => {
  const subpage = watchOwnPathChange("/space", "Folder/Child.md");
  const rootPage = watchOwnPathChange("/space", "Other.md");
  try {
    await trackOwnContentDeletion(
      { spacePath: "/space", path: "Folder/README.md" },
      async () => {},
    );
    await trackOwnContentDeletion(
      { spacePath: "/space", path: "README.md" },
      async () => {},
    );
    expect(subpage.changedHere()).toBe(true);
    expect(rootPage.changedHere()).toBe(false);
  } finally {
    subpage.stop();
    rootPage.stop();
  }
});

test("a failed own deletion and one finished before the watch are not this Page's", async () => {
  await trackOwnContentDeletion(
    { spacePath: "/space", path: "Early.md" },
    async () => {},
  );
  const early = watchOwnPathChange("/space", "Early.md");
  const failed = watchOwnPathChange("/space", "Failed.md");
  try {
    const failure = await trackOwnContentDeletion(
      { spacePath: "/space", path: "Failed.md" },
      async () => {
        throw new Error("Access denied");
      },
    ).catch((error: unknown) => error);
    expect(String(failure)).toBe("Error: Access denied");
    expect(early.changedHere()).toBe(false);
    expect(failed.changedHere()).toBe(false);
  } finally {
    early.stop();
    failed.stop();
  }
});

test("a running or finished own rename or move of a folder leaves the Pages under it", async () => {
  const deleted: string[] = [];
  const page = watchOwnPathChange("/space", "docs/sub/a.md", () =>
    deleted.push("page"),
  );
  const prefixed = watchOwnPathChange("/space", "docs-old/a.md");
  try {
    let running = false;
    await trackOwnContentRelocation(
      { spacePath: "/space", path: "docs" },
      async () => {
        running = page.changedHere();
      },
    );
    expect(running).toBe(true);
    expect(page.changedHere()).toBe(true);
    expect(prefixed.changedHere()).toBe(false);
    // Only a deletion tells the Page to check itself without a watcher event.
    expect(deleted).toEqual([]);
  } finally {
    page.stop();
    prefixed.stop();
  }
});

test("a title rename leaves the Pages under its README only when the path changed", async () => {
  const kept = watchOwnPathChange("/space", "kept/a.md");
  const renamed = watchOwnPathChange("/space", "docs/a.md");
  const failed = watchOwnPathChange("/space", "failed/a.md");
  try {
    await trackOwnContentRelocation(
      { spacePath: "/space", path: "kept/README.md" },
      async () => ({ path: "kept/README.md" }),
      (page) => page.path !== "kept/README.md",
    );
    await trackOwnContentRelocation(
      { spacePath: "/space", path: "docs/README.md" },
      async () => ({ path: "notes/README.md" }),
      (page) => page.path !== "docs/README.md",
    );
    await trackOwnContentRelocation(
      { spacePath: "/space", path: "failed" },
      async () => {
        throw new Error("Name taken");
      },
    ).catch(() => undefined);
    expect(kept.changedHere()).toBe(false);
    expect(renamed.changedHere()).toBe(true);
    expect(failed.changedHere()).toBe(false);
  } finally {
    kept.stop();
    renamed.stop();
    failed.stop();
  }
});
