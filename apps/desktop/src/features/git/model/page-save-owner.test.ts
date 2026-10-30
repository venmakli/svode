import { expect, test as bunTest } from "bun:test";

import {
  dispatchPageSave,
  explicitCommitRefusal,
  registerPageSaveOwner,
} from "./page-save-owner";
import type { GitSaveScope } from "./save-scope";

const releases: (() => void)[] = [];
const choices: string[] = [];

/** Each case starts without registered owners. */
function test(name: string, run: () => void | Promise<void>) {
  bunTest(name, async () => {
    try {
      await run();
    } finally {
      releases.splice(0).forEach((release) => release());
      choices.length = 0;
    }
  });
}

function owner(spacePath: string, path: string, conflicted: () => boolean) {
  releases.push(
    registerPageSaveOwner(spacePath, path, {
      save: async () => null,
      saveAll: async () => null,
      sourceConflict: () =>
        conflicted()
          ? { title: path, chooseVersion: () => choices.push(path) }
          : null,
    }),
  );
}

const space: GitSaveScope = { kind: "space", path: "", label: "space" };
const file = (path: string): GitSaveScope => ({
  kind: "file",
  path,
  label: "page",
});
const folder = (path: string): GitSaveScope => ({
  kind: "container",
  path,
  nodePath: path,
  hasSchema: false,
  label: "folder",
});

test("no refusal without an open Page in a source conflict", () => {
  expect(explicitCommitRefusal("/space", space)).toBeNull();
  owner("/space", "notes/plan.md", () => false);
  expect(explicitCommitRefusal("/space", space)).toBeNull();
  expect(explicitCommitRefusal("/space", file("notes/plan.md"))).toBeNull();
});

test("a Page in a source conflict refuses each area that holds its path", () => {
  owner("/space", "notes/plan.md", () => true);
  for (const scope of [space, folder("notes"), file("notes/plan.md")]) {
    const refusal = explicitCommitRefusal("/space", scope);
    expect(refusal?.path).toBe("notes/plan.md");
    expect(refusal?.title).toBe("notes/plan.md");
  }
  for (const scope of [folder("other"), file("notes/other.md")])
    expect(explicitCommitRefusal("/space", scope)).toBeNull();
  // Another Space of the window is a different area.
  expect(explicitCommitRefusal("/other-space", space)).toBeNull();

  explicitCommitRefusal("/space", space)!.chooseVersion();
  expect(choices).toEqual(["notes/plan.md"]);
});

test("the refusal names the first Page by path, and any owner of a path counts", () => {
  owner("/space", "notes/zulu.md", () => true);
  owner("/space", "notes/alpha.md", () => false);
  owner("/space", "notes/alpha.md", () => true);
  owner("/space", "notes/bravo.md", () => true);
  expect(explicitCommitRefusal("/space", space)?.path).toBe("notes/alpha.md");
  expect(explicitCommitRefusal("/space", file("notes/zulu.md"))?.path).toBe(
    "notes/zulu.md",
  );
});

test("a Page of a Space inside the committed Space is in its area", () => {
  owner("/project/spaces/team", "plan.md", () => true);
  owner("C:\\project\\spaces\\team\\", "plan.md", () => true);
  expect(explicitCommitRefusal("/project", space)?.path).toBe(
    "spaces/team/plan.md",
  );
  expect(explicitCommitRefusal("/project", folder("spaces"))?.path).toBe(
    "spaces/team/plan.md",
  );
  expect(explicitCommitRefusal("/project", folder("docs"))).toBeNull();
  expect(explicitCommitRefusal("C:\\project", space)?.path).toBe(
    "spaces/team/plan.md",
  );
  // A sibling whose path only starts the same way is outside.
  expect(explicitCommitRefusal("/project/spaces/tea", space)).toBeNull();
});

test("the owner of the Page returns its refusal through the dispatch", async () => {
  const refusal = {
    path: "plan.md",
    title: "Plan",
    chooseVersion: () => undefined,
  };
  releases.push(
    registerPageSaveOwner("/space", "plan.md", {
      save: async () => refusal,
      saveAll: async () => null,
      sourceConflict: () => null,
    }),
  );
  expect(await dispatchPageSave("/space", "plan.md", false)).toBe(refusal);
  expect(await dispatchPageSave("/space", "plan.md", true)).toBeNull();
});
