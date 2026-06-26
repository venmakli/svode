import { expect, test } from "bun:test";
import { repairParentPathForSpaceFileEvent } from "./space-file-watch-events";

test("repair parent targets document direct parent", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/new.md",
      kind: "document",
      parentPath: "docs",
    }),
  ).toBe("docs");
});

test("repair parent targets folder row parent for readme metadata", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/README.md",
      kind: "document",
      parentPath: "docs",
    }),
  ).toBe("");
});

test("repair parent targets collection row parent for schema marker", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/tasks/schema.yaml",
      kind: "schema",
      parentPath: "docs/tasks",
    }),
  ).toBe("docs");
});

test("repair parent targets deleted folder parent", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/archive",
      kind: "folder",
      isDir: true,
      parentPath: "docs",
    }),
  ).toBe("docs");
});
