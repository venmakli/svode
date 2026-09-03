import type { PDFDocumentProxy } from "pdfjs-dist";

import type { PdfTextIndex, PdfTextPage } from "../model/types";

const PDF_TEXT_CHARACTER_LIMIT = 1_000_000;
const PDF_FIND_MATCH_LIMIT = 10_000;

export interface PdfFindMatch {
  pageNumber: number;
  occurrence: number;
}

export async function extractPdfText(
  pdf: PDFDocumentProxy,
  signal: AbortSignal,
  onUpdate: (index: PdfTextIndex) => void,
) {
  const pages: PdfTextPage[] = [];
  let characters = 0;
  let truncated = false;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (signal.aborted || truncated) return;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    const remaining = PDF_TEXT_CHARACTER_LIMIT - characters;
    const bounded = text.slice(0, Math.max(remaining, 0));
    pages.push({ pageNumber, text: bounded });
    characters += bounded.length;
    truncated =
      bounded.length < text.length || characters >= PDF_TEXT_CHARACTER_LIMIT;
    onUpdate({ complete: false, pages: [...pages], truncated });
  }

  if (!signal.aborted) {
    onUpdate({ complete: true, pages, truncated });
  }
}

export function findPdfTextMatches(
  index: PdfTextIndex,
  query: string,
): PdfFindMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const matches: PdfFindMatch[] = [];
  for (const page of index.pages) {
    const haystack = page.text.toLocaleLowerCase();
    let fromIndex = 0;
    let occurrence = 0;
    while (matches.length < PDF_FIND_MATCH_LIMIT) {
      const matchIndex = haystack.indexOf(normalizedQuery, fromIndex);
      if (matchIndex < 0) break;
      matches.push({ occurrence, pageNumber: page.pageNumber });
      occurrence += 1;
      fromIndex = matchIndex + Math.max(normalizedQuery.length, 1);
    }
    if (matches.length >= PDF_FIND_MATCH_LIMIT) break;
  }
  return matches;
}
