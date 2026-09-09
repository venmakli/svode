import { expect, test } from "bun:test";
import {
  assertNormalizedOwnerPath,
  createAppDirectoryOwner,
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
  createPageOwner,
} from "./owners";
import { resolveDefaultScopeSurface } from "./active-surface";

test("registered space keeps space identity and gains hybrid capabilities", () => {
  expect(
    createRegisteredSpaceOwner({
      spaceId: "design",
      projectPath: "/repo",
      spacePath: "/repo/design",
      status: "ready",
      hasSchema: true,
    }),
  ).toEqual({
    ownerKey: "space:design",
    identityKind: "registered-space",
    spaceId: "design",
    projectPath: "/repo",
    spacePath: "/repo/design",
    ownerPath: ".",
    readmePath: "README.md",
    capabilities: ["space", "collection"],
  });
});

test("collection directory owner uses normalized path in its transient key", () => {
  const owner = createCollectionDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath: "Команды/Design",
    status: "ready",
    hasSchema: true,
  });

  expect(owner.ownerKey).toBe("collection:root:Команды/Design");
  expect(owner.readmePath).toBe("Команды/Design/README.md");
});

test("app-only directory owner keeps one path-owned identity", () => {
  expect(
    createAppDirectoryOwner({
      spaceId: "root",
      projectPath: "/repo",
      spacePath: "/repo",
      ownerPath: "tools/calculator",
      status: "ready",
      hasApp: true,
    }),
  ).toEqual({
    ownerKey: "app:root:tools/calculator",
    identityKind: "app-directory",
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath: "tools/calculator",
    readmePath: "tools/calculator/README.md",
    capabilities: ["app"],
  });
});

test("normal host rejects unavailable spaces and unsafe owner paths", () => {
  expectThrows(() =>
    createRegisteredSpaceOwner({
      spaceId: "missing",
      projectPath: "/repo",
      spacePath: "/repo/missing",
      status: "missing",
      hasSchema: false,
    }),
  );

  for (const path of [
    "",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
  ]) {
    expectThrows(() => assertNormalizedOwnerPath(path));
  }

  expectThrows(() =>
    createCollectionDirectoryOwner({
      spaceId: "root",
      projectPath: "/repo",
      spacePath: "/repo",
      ownerPath: "notes",
      status: "ready",
      hasSchema: false,
    }),
  );
});

function expectThrows(action: () => unknown) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error instanceof Error).toBe(true);
}

test("Page identity follows explicit form facts, not a README suffix", () => {
  const input = {
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready" as const,
    contentPath: "Notes/Readme.md",
  };
  const leaf = createPageOwner({ ...input, form: "leaf" });
  const folder = createPageOwner({
    ...input,
    form: "folder",
    ownerPath: "Notes",
    hasApp: true,
  });
  expect(leaf.identityKind).toBe("page-file");
  expect(leaf.ownerKey).toBe("page:root:Notes/Readme.md");
  expect(leaf.capabilities).toEqual([]);
  expect(folder.identityKind).toBe("page-directory");
  expect(folder.ownerKey).toBe("page:root:Notes");
  expect(folder.readmePath).toBe(input.contentPath);
  expect(folder.capabilities).toEqual(["app"]);
  expect(resolveDefaultScopeSurface(leaf)).toBe("readme");
  expect(resolveDefaultScopeSurface(folder)).toBe("readme");
});

test("Page owner rejects unavailable Space and inconsistent folder facts", () => {
  const input = {
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready" as const,
    contentPath: "Notes/README.md",
    form: "folder" as const,
    ownerPath: "Notes",
    hasApp: false,
  };
  for (const changes of [
    { status: "missing" as const },
    { ownerPath: "." },
    { contentPath: "Other/README.md" },
    { contentPath: "Notes/body.md" },
    { contentPath: "Notes/../README.md" },
    { ownerPath: "/Notes" },
  ]) {
    expectThrows(() => createPageOwner({ ...input, ...changes }));
  }
});
