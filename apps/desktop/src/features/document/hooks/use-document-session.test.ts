import { expect, test } from "bun:test";

import { DocxRuntimeFailure } from "../docx/docx-runtime";
import { XlsxRuntimeFailure } from "../xlsx/xlsx-runtime";
import { PptxRuntimeFailure } from "../pptx/pptx-runtime";
import { failureFromError } from "./use-document-session";

test("preserves a DOCX runtime failure message as diagnostic detail", () => {
  expect(
    failureFromError(
      new DocxRuntimeFailure("renderer_error", "DOCX renderer failed"),
    ),
  ).toEqual({
    detail: "DOCX renderer failed",
    kind: "renderer_error",
  });
});

test("preserves an XLSX runtime failure message as diagnostic detail", () => {
  expect(
    failureFromError(
      new XlsxRuntimeFailure("resource_limit", "XLSX used range is too large"),
    ),
  ).toEqual({
    detail: "XLSX used range is too large",
    kind: "resource_limit",
  });
});

test("preserves a PPTX runtime failure message as diagnostic detail", () => {
  expect(
    failureFromError(
      new PptxRuntimeFailure("renderer_error", "PPTX renderer failed"),
    ),
  ).toEqual({
    detail: "PPTX renderer failed",
    kind: "renderer_error",
  });
});
