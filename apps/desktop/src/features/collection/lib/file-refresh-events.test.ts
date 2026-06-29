import { expect, test } from "bun:test";
import { collectionFileChangeKind } from "./file-refresh-events";

test("collectionFileChangeKind treats schema.yaml as schema refresh", () => {
  expect(collectionFileChangeKind("tasks/schema.yaml")).toBe("schema");
  expect(collectionFileChangeKind("docs\\tasks\\schema.yaml")).toBe("schema");
});

test("collectionFileChangeKind treats markdown as entries refresh", () => {
  expect(collectionFileChangeKind("tasks/card.md")).toBe("entries");
  expect(collectionFileChangeKind("docs\\tasks\\card.MD")).toBe("entries");
});

test("collectionFileChangeKind ignores unrelated files", () => {
  expect(collectionFileChangeKind("tasks/schema.yml")).toBeNull();
  expect(collectionFileChangeKind("tasks/image.png")).toBeNull();
});
