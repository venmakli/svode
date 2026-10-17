import { expect, test } from "bun:test";
import { trackOwnContentDeletion, watchOwnPageDeletion } from "./own-deletion";

test("a running or finished own deletion removes the Page it covers", async () => {
  const page = watchOwnPageDeletion("/space", "Notes/Item.md");
  const sibling = watchOwnPageDeletion("/space", "Notes2/Item.md");
  const otherSpace = watchOwnPageDeletion("/other", "Notes/Item.md");
  try {
    let running = false;
    await trackOwnContentDeletion(
      { spacePath: "/space/", path: "Notes" },
      async () => {
        running = page.deletedHere();
      },
    );
    expect(running).toBe(true);
    expect(page.deletedHere()).toBe(true);
    expect(sibling.deletedHere()).toBe(false);
    expect(otherSpace.deletedHere()).toBe(false);
  } finally {
    page.stop();
    sibling.stop();
    otherSpace.stop();
  }
});

test("a nested README deletion removes its directory, a root README only itself", async () => {
  const subpage = watchOwnPageDeletion("/space", "Folder/Child.md");
  const rootPage = watchOwnPageDeletion("/space", "Other.md");
  try {
    await trackOwnContentDeletion(
      { spacePath: "/space", path: "Folder/README.md" },
      async () => {},
    );
    await trackOwnContentDeletion(
      { spacePath: "/space", path: "README.md" },
      async () => {},
    );
    expect(subpage.deletedHere()).toBe(true);
    expect(rootPage.deletedHere()).toBe(false);
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
  const early = watchOwnPageDeletion("/space", "Early.md");
  const failed = watchOwnPageDeletion("/space", "Failed.md");
  try {
    const failure = await trackOwnContentDeletion(
      { spacePath: "/space", path: "Failed.md" },
      async () => {
        throw new Error("Access denied");
      },
    ).catch((error: unknown) => error);
    expect(String(failure)).toBe("Error: Access denied");
    expect(early.deletedHere()).toBe(false);
    expect(failed.deletedHere()).toBe(false);
  } finally {
    early.stop();
    failed.stop();
  }
});
