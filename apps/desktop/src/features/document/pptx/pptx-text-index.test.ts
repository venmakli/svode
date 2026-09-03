import { expect, test } from "bun:test";

import { extractPptxText, PPTX_TEXT_LIMIT } from "./pptx-text-index";

test("freezes the PPTX extracted text budget", () => {
  expect(PPTX_TEXT_LIMIT).toBe(1_000_000);
});

test("extracts slide text and speaker notes with stable slide locators", async () => {
  const presentation = {
    collectSlideRuns: async (slideIndex: number) =>
      slideIndex === 0
        ? [{ text: "Quarterly plan" }, { text: "Revenue up" }]
        : [{ text: "Next steps" }],
    getNotes: (slideIndex: number) =>
      slideIndex === 0 ? "Mention regional variance" : null,
    slideCount: 2,
  };

  const index = await extractPptxText(
    presentation,
    new AbortController().signal,
  );

  expect(index).toEqual({
    complete: true,
    slides: [
      {
        notes: "Mention regional variance",
        slideIndex: 0,
        text: "Quarterly plan\nRevenue up",
      },
      { notes: undefined, slideIndex: 1, text: "Next steps" },
    ],
    truncated: false,
  });
});

test("stops extraction on a text item boundary", async () => {
  const presentation = {
    collectSlideRuns: async () => [{ text: "Alpha" }, { text: "Beta" }],
    getNotes: () => null,
    slideCount: 1,
  };

  const index = await extractPptxText(
    presentation,
    new AbortController().signal,
    7,
  );

  expect(index.slides[0]?.text).toBe("Alpha");
  expect(index.truncated).toBe(true);
  expect(index.complete).toBe(false);
});
