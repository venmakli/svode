import { expect, test } from "bun:test";
import {
  documentNameConflictFromError,
  documentNameKey,
  findDocumentNameConflictPath,
} from "./document-name";

test("normalizes compatibility characters and Unicode whitespace", () => {
  expect(documentNameKey("  ＱＵＡＲＴＥＲＬＹ\u2003Review ")).toBe(
    "quarterly review",
  );
});

test("finds a sibling conflict but excludes the current artifact and collections", () => {
  const siblings = [
    { path: "one.md", title: "One", has_schema: false },
    { path: "collection/README.md", title: "One", has_schema: true },
  ];
  expect(findDocumentNameConflictPath("one", siblings, "other.md")).toBe(
    "one.md",
  );
  expect(findDocumentNameConflictPath("one", siblings, "one.md")).toBeNull();
});

test("reads a structured backend race conflict", () => {
  expect(
    documentNameConflictFromError({
      kind: "document_name_conflict",
      conflict: {
        parentPath: "docs",
        conflicts: [{ path: "docs/one.md", title: "One" }],
      },
    }),
  ).toEqual({
    parentPath: "docs",
    conflicts: [{ path: "docs/one.md", title: "One" }],
  });
});
