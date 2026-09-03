import { expect, test } from "bun:test";

import { DocxRuntimeFailure } from "../docx/docx-runtime";
import { XlsxRuntimeFailure } from "../xlsx/xlsx-runtime";
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
