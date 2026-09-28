import { expect, test } from "bun:test";
import {
  affectsScopeOwnerFacts,
  createScopeOwner,
  knownScopeOwnerFacts,
  type ScopeOwnerFacts,
} from "./owner-facts";

const space = {
  spaceId: "root",
  spacePath: "/space",
  projectPath: "/project",
};

const matrix: {
  name: string;
  facts: ScopeOwnerFacts;
  node: Parameters<typeof knownScopeOwnerFacts>[1];
  identityKind: string;
  capabilities: string[];
}[] = [
  {
    name: "leaf Page",
    facts: {
      identity: "page-file",
      ownerPath: "tasks/Item.md",
      contentPath: "tasks/Item.md",
      hasApp: false,
    },
    node: { path: "tasks/Item.md", has_schema: false, kind: "page" },
    identityKind: "page-file",
    capabilities: [],
  },
  {
    name: "directory-backed Page",
    facts: {
      identity: "page-directory",
      ownerPath: "Docs",
      contentPath: "Docs/README.md",
      hasApp: false,
    },
    node: { path: "Docs/README.md", has_schema: false, kind: "page" },
    identityKind: "page-directory",
    capabilities: [],
  },
  {
    name: "directory-backed Page + App",
    facts: {
      identity: "page-directory",
      ownerPath: "Docs",
      contentPath: "Docs/README.md",
      hasApp: true,
    },
    node: {
      path: "Docs/README.md",
      has_schema: false,
      has_app: true,
      kind: "page",
    },
    identityKind: "page-directory",
    capabilities: ["app"],
  },
  {
    name: "Collection directory",
    facts: {
      identity: "collection-directory",
      ownerPath: "tasks",
      contentPath: "tasks/README.md",
      hasApp: false,
    },
    node: { path: "tasks", has_schema: true, kind: "collection" },
    identityKind: "collection-directory",
    capabilities: ["collection"],
  },
  {
    name: "Collection directory + App",
    facts: {
      identity: "collection-directory",
      ownerPath: "tasks",
      contentPath: "tasks/README.md",
      hasApp: true,
    },
    node: {
      path: "tasks",
      has_schema: true,
      has_app: true,
      kind: "collection",
    },
    identityKind: "collection-directory",
    capabilities: ["collection", "app"],
  },
  {
    name: "App-only directory",
    facts: {
      identity: "app-directory",
      ownerPath: "Tool",
      contentPath: "Tool/README.md",
      hasApp: true,
    },
    node: { path: "Tool", has_schema: false, has_app: true, kind: "app" },
    identityKind: "app-directory",
    capabilities: ["app"],
  },
];

test("one owner per facts for every DF-122 target, and tree facts seed the same owner", () => {
  for (const entry of matrix) {
    const owner = createScopeOwner(space, entry.facts);
    expect([entry.name, owner.identityKind]).toEqual([
      entry.name,
      entry.identityKind,
    ]);
    expect([entry.name, [...owner.capabilities]]).toEqual([
      entry.name,
      entry.capabilities,
    ]);
    expect(owner.readmePath).toBe(entry.facts.contentPath);
    expect(owner.spacePath).toBe(space.spacePath);
    const target = entry.facts.contentPath.endsWith("README.md")
      ? entry.facts.identity === "page-directory"
        ? entry.facts.contentPath
        : entry.facts.ownerPath
      : entry.facts.contentPath;
    expect([entry.name, knownScopeOwnerFacts(target, entry.node)]).toEqual([
      entry.name,
      entry.facts,
    ]);
  }
});

test("tree facts never seed an owner for a plain directory or a mismatched file", () => {
  expect(
    knownScopeOwnerFacts("Plain", {
      path: "Plain",
      has_schema: false,
      kind: "folder",
    }),
  ).toBeNull();
  expect(
    knownScopeOwnerFacts("tasks/Item.md", {
      path: "tasks/Item.md",
      has_schema: true,
    }),
  ).toBeNull();
  // A retargeted leaf seeds the directory form of its new README path.
  expect(
    knownScopeOwnerFacts("Note/README.md", {
      path: "Note.md",
      has_schema: false,
      kind: "page",
    }),
  ).toEqual({
    identity: "page-directory",
    ownerPath: "Note",
    contentPath: "Note/README.md",
    hasApp: false,
  });
});

test("only the target and the direct markers of its owner directory re-check facts", () => {
  const [leaf, folder, collection] = [matrix[0], matrix[2], matrix[4]].map(
    (entry) => entry.facts,
  );
  expect(affectsScopeOwnerFacts("tasks/Item.md", leaf, "tasks/Item.md")).toBe(
    true,
  );
  for (const sibling of [
    "tasks/Other.md",
    "tasks/schema.yaml",
    "tasks/app.yaml",
    "tasks/README.md",
  ])
    expect(affectsScopeOwnerFacts("tasks/Item.md", leaf, sibling)).toBe(false);

  for (const marker of [
    "Docs",
    "Docs/README.md",
    "Docs/readme.md",
    "Docs/schema.yaml",
    "Docs/app.yaml",
  ])
    expect(affectsScopeOwnerFacts("Docs/README.md", folder, marker)).toBe(true);
  for (const unrelated of [
    "Docs/page.md",
    "Docs/Sub/app.yaml",
    "Docs/assets/image.png",
    "Other/app.yaml",
  ])
    expect(affectsScopeOwnerFacts("Docs/README.md", folder, unrelated)).toBe(
      false,
    );

  expect(affectsScopeOwnerFacts("tasks", collection, "tasks/Item.md")).toBe(
    false,
  );
  expect(affectsScopeOwnerFacts("tasks", collection, "tasks/app.yaml")).toBe(
    true,
  );
  // Before the first answer the target path shape names the owner directory.
  expect(affectsScopeOwnerFacts("Tool", null, "Tool/app.yaml")).toBe(true);
  expect(affectsScopeOwnerFacts("Tool", null, "Tool/data.json")).toBe(false);
});
