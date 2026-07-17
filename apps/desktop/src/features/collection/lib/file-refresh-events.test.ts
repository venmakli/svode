import { expect, test } from "bun:test";
import {
  collectionFileChangeKind,
  isCollectionSchemaPath,
} from "./file-refresh-events";

test("collectionFileChangeKind refreshes the owning schema only", () => {
  expect(collectionFileChangeKind("tasks/schema.yaml", "tasks")).toBe("schema");
  expect(
    collectionFileChangeKind("docs\\tasks\\schema.yaml", "docs/tasks"),
  ).toBe("schema");
  expect(collectionFileChangeKind("other/schema.yaml", "tasks")).toBeNull();
  expect(
    collectionFileChangeKind("tasks/nested/schema.yaml", "tasks"),
  ).toBeNull();
  expect(collectionFileChangeKind("tasks/schema.yaml", "Tasks")).toBeNull();
  expect(isCollectionSchemaPath("schema.yaml", ".")).toBe(true);
  expect(isCollectionSchemaPath("tasks/schema.yaml", ".")).toBe(false);
});

test("collectionFileChangeKind refreshes entries inside its owner only", () => {
  expect(collectionFileChangeKind("tasks/card.md", "tasks")).toBe("entries");
  expect(collectionFileChangeKind("docs\\tasks\\card.MD", "docs/tasks")).toBe(
    "entries",
  );
  expect(collectionFileChangeKind("other/card.md", "tasks")).toBeNull();
  expect(collectionFileChangeKind("tasks/card.md", "Tasks")).toBeNull();
});

test("collectionFileChangeKind ignores unrelated files", () => {
  expect(collectionFileChangeKind("tasks/schema.yml", "tasks")).toBeNull();
  expect(collectionFileChangeKind("tasks/image.png", "tasks")).toBeNull();
});
