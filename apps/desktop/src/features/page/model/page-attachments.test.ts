import { expect, test } from "bun:test";

import { pageAttachmentOwnerPath } from "./page-attachments";

test("only directory-backed Pages resolve an Attachments owner", () => {
  expect(
    pageAttachmentOwnerPath("roadmap.md", {
      form: "leaf",
      otherFileCount: 0,
      subpageCount: 0,
    }),
  ).toBeNull();
  expect(
    pageAttachmentOwnerPath("roadmap/README.md", {
      form: "folder",
      otherFileCount: 1,
      subpageCount: 0,
    }),
  ).toBe("roadmap");
  expect(
    pageAttachmentOwnerPath("roadmap/README.md", {
      form: "nestedCollection",
      otherFileCount: 0,
      subpageCount: 1,
    }),
  ).toBeNull();
});
