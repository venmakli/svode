import { expect, test } from "bun:test";
import type {
  BodyElement,
  DocxDocumentModel,
  HeadersFooters,
} from "@silurus/ooxml/docx";

import { extractDocxText } from "./docx-text-index";

const EMPTY_HEADERS: HeadersFooters = {
  default: null,
  even: null,
  first: null,
};

test("extracts bounded paragraph, field, shape, table, header, and footer text", () => {
  const document = fixture([
    paragraph([
      { text: "Heading", type: "text" },
      { fallbackText: " 42", type: "field" },
      { textBlocks: [{ text: "Diagram" }], type: "shape" },
    ]),
    {
      rows: [
        {
          cells: [
            { content: [paragraph([{ text: "A", type: "text" }])] },
            { content: [paragraph([{ text: "B", type: "text" }])] },
          ],
        },
      ],
      type: "table",
    } as BodyElement,
  ]);
  document.headers.default = { body: [paragraph([{ text: "Header", type: "text" }])] };
  document.footers.default = { body: [paragraph([{ text: "Footer", type: "text" }])] };

  const index = extractDocxText(document);

  expect(index.complete).toBe(true);
  expect(index.truncated).toBe(false);
  expect(index.text.includes("Heading 42Diagram")).toBe(true);
  expect(index.text.includes("A\n\tB")).toBe(true);
  expect(index.text.includes("Header")).toBe(true);
  expect(index.text.includes("Footer")).toBe(true);
});

test("stops extraction at a character boundary without splitting a surrogate", () => {
  const index = extractDocxText(
    fixture([paragraph([{ text: "A😀B", type: "text" }])]),
    2,
  );

  expect(index.text).toBe("A");
  expect(index.complete).toBe(false);
  expect(index.truncated).toBe(true);
});

function fixture(body: BodyElement[]) {
  return {
    body,
    footers: { ...EMPTY_HEADERS },
    headers: { ...EMPTY_HEADERS },
    section: {},
  } as DocxDocumentModel;
}

function paragraph(runs: unknown[]) {
  return { runs, type: "paragraph" } as BodyElement;
}
