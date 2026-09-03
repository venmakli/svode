import { expect, test } from "bun:test";

import { DocxRuntimeFailure } from "../docx/docx-runtime";
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
