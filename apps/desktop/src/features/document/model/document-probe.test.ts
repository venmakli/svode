import { expect, test } from "bun:test";

import { probeDocumentTarget } from "./document-probe";

test("document probe recognizes preview and external-only formats", () => {
  for (const path of ["guide.pdf", "brief.DOCX", "table.xls", "slides.pptm"]) {
    const result = probeDocumentTarget({
      path,
      sourceShape: "file",
      spaceId: "space",
    });
    expect(result.status).toBe("match");
    if (result.status === "match") {
      expect(result.identity.kind).toBe("document");
      expect(result.identity.path).toBe(path);
    }
  }
});

test("document probe does not claim directories or unknown files", () => {
  expect(
    probeDocumentTarget({
      path: "folder/README.md",
      sourceShape: "directory",
      spaceId: "space",
    }),
  ).toEqual({ status: "no_match" });
  expect(
    probeDocumentTarget({
      path: "archive.zip",
      sourceShape: "file",
      spaceId: "space",
    }),
  ).toEqual({ status: "no_match" });
});
