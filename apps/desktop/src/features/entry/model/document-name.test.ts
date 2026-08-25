import { expect, test } from "bun:test";
import {
  documentNameConflictDisplayPath,
  documentNameConflictFromError,
  documentNameKey,
  findDocumentNameConflictPath,
} from "./document-name";

test("normalizes compatibility characters and Unicode whitespace", () => {
  expect(documentNameKey("  ＱＵＡＲＴＥＲＬＹ\u2003Review ")).toBe(
    "quarterly review",
  );
});

test("finds a sibling conflict across document and collection entries but excludes the current artifact", () => {
  const siblings = [
    { path: "one.md", title: "One", has_schema: false },
    { path: "collection/README.md", title: "One", has_schema: true },
  ];
  expect(findDocumentNameConflictPath("one", siblings, "other.md")).toBe(
    "one.md",
  );
  expect(findDocumentNameConflictPath("one", siblings, "one.md")).toBe(
    "collection/README.md",
  );
  expect(
    findDocumentNameConflictPath("one", siblings, "collection/README.md"),
  ).toBe("one.md");
});

test("shows the current path only for a projected external conflict", () => {
  expect(
    documentNameConflictDisplayPath({
      path: "collection/one.md",
      name_conflict: {
        parentPath: "collection",
        conflicts: [{ path: "collection/two.md", title: "One" }],
      },
    }),
  ).toBe("collection/one.md");
  expect(
    documentNameConflictDisplayPath({ path: "collection/one.md" }),
  ).toBeNull();
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
