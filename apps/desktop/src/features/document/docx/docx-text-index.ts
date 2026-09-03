import type {
  BodyElement,
  DocParagraph,
  DocRun,
  DocTable,
  DocxDocumentModel,
  HeaderFooter,
  HeadersFooters,
} from "@silurus/ooxml/docx";

import type { DocxTextIndex } from "../model/types";

export const DOCX_TEXT_LIMIT = 1_000_000;

export function extractDocxText(
  document: DocxDocumentModel,
  limit = DOCX_TEXT_LIMIT,
): DocxTextIndex {
  const collector = new BoundedTextCollector(limit);
  collectBody(document.body, collector);
  collectHeadersFooters(document.headers, collector);
  collectHeadersFooters(document.footers, collector);
  return collector.result();
}

function collectBody(
  elements: readonly BodyElement[],
  collector: BoundedTextCollector,
) {
  for (const element of elements) {
    if (collector.full) return;
    if (element.type === "paragraph") {
      collectParagraph(element, collector);
    } else if (element.type === "table") {
      collectTable(element, collector);
    } else if (element.type === "sectionBreak") {
      if (element.headers) collectHeadersFooters(element.headers, collector);
      if (element.footers) collectHeadersFooters(element.footers, collector);
    }
  }
}

function collectParagraph(
  paragraph: DocParagraph,
  collector: BoundedTextCollector,
) {
  for (const run of paragraph.runs) {
    if (collector.full) return;
    collector.append(textFromRun(run));
  }
  collector.append("\n");
}

function collectTable(table: DocTable, collector: BoundedTextCollector) {
  for (const row of table.rows) {
    for (const [cellIndex, cell] of row.cells.entries()) {
      for (const element of cell.content) {
        if (element.type === "paragraph") {
          collectParagraph(element, collector);
        } else {
          collectTable(element, collector);
        }
        if (collector.full) return;
      }
      if (cellIndex < row.cells.length - 1) collector.append("\t");
    }
    collector.append("\n");
    if (collector.full) return;
  }
}

function collectHeadersFooters(
  value: HeadersFooters,
  collector: BoundedTextCollector,
) {
  for (const part of [value.default, value.first, value.even]) {
    collectHeaderFooter(part, collector);
    if (collector.full) return;
  }
}

function collectHeaderFooter(
  value: HeaderFooter | null,
  collector: BoundedTextCollector,
) {
  if (value) collectBody(value.body, collector);
}

function textFromRun(run: DocRun) {
  switch (run.type) {
    case "text":
      return run.text;
    case "field":
      return run.fallbackText;
    case "shape":
      return (run.textBlocks ?? []).map((block) => block.text).join("\n");
    case "break":
      return run.breakType === "line" ? "\n" : "";
    default:
      return "";
  }
}

class BoundedTextCollector {
  private chunks: string[] = [];
  private length = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  get full() {
    return this.truncated;
  }

  append(value: string) {
    if (!value || this.truncated) return;
    const remaining = Math.max(this.limit - this.length, 0);
    if (value.length <= remaining) {
      this.chunks.push(value);
      this.length += value.length;
      return;
    }
    const slice = sliceWithoutBrokenSurrogate(value, remaining);
    if (slice) this.chunks.push(slice);
    this.length += slice.length;
    this.truncated = true;
  }

  result(): DocxTextIndex {
    return {
      complete: !this.truncated,
      text: this.chunks.join("").trimEnd(),
      truncated: this.truncated,
    };
  }
}

function sliceWithoutBrokenSurrogate(value: string, length: number) {
  let end = Math.min(Math.max(length, 0), value.length);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
