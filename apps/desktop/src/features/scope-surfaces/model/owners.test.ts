import { expect, test } from "bun:test";
import {
  assertNormalizedOwnerPath,
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "./owners";

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
