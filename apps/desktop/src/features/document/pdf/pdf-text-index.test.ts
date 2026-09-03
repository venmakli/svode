import { expect, test } from "bun:test";

import { findPdfTextMatches } from "./pdf-text-index";

test("PDF find returns stable page locators without requiring persisted extraction", () => {
  const matches = findPdfTextMatches(
    {
      complete: true,
      pages: [
        { pageNumber: 1, text: "First local result" },
        { pageNumber: 2, text: "Local result and another local result" },
      ],
      truncated: false,
    },
    "LOCAL RESULT",
  );
  expect(matches).toEqual([
    { occurrence: 0, pageNumber: 1 },
    { occurrence: 0, pageNumber: 2 },
    { occurrence: 1, pageNumber: 2 },
  ]);
});

test("PDF find ignores an empty query", () => {
  expect(
    findPdfTextMatches({ complete: false, pages: [], truncated: false }, "   "),
  ).toEqual([]);
});
