import { expect, test } from "bun:test";

import { documentHasInlinePreview } from "../model/types";
import {
  normalizePptxRuntimeError,
  selectPptxRenderMode,
  validatePptxPresentationBounds,
  PPTX_DECODED_IMAGE_BUDGET,
  PPTX_IMAGE_RESOURCES,
  PPTX_LOAD_TIMEOUT_MS,
  PPTX_RESOURCE_LIMITS,
  PPTX_SLIDE_LIMIT,
  PptxPasswordFailure,
  PptxRuntimeFailure,
} from "./pptx-runtime";

test("freezes PPTX archive, image, slide, text-source, and time budgets", () => {
  expect(PPTX_RESOURCE_LIMITS).toEqual({
    maxArchiveEntries: 2_048,
    maxArchiveEntryBytes: 32 * 1024 * 1024,
    maxTotalInflatedBytes: 96 * 1024 * 1024,
  });
  expect(PPTX_IMAGE_RESOURCES).toEqual({
    decodedByteBudget: PPTX_DECODED_IMAGE_BUDGET,
    strategy: "strict",
  });
  expect(PPTX_DECODED_IMAGE_BUDGET).toBe(64 * 1024 * 1024);
  expect(PPTX_SLIDE_LIMIT).toBe(2_000);
  expect(PPTX_LOAD_TIMEOUT_MS).toBe(30_000);
  expect(documentHasInlinePreview("pptx")).toBe(true);
});

test("uses worker rendering only when the complete bitmap path is available", () => {
  expect(
    selectPptxRenderMode({
      bitmapRenderer: true,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("worker");
  expect(
    selectPptxRenderMode({
      bitmapRenderer: false,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("main");
});

test("rejects empty and over-limit slide sets before rendering", () => {
  let emptyFailure: unknown;
  let largeFailure: unknown;
  try {
    validatePptxPresentationBounds({ slideCount: 0 });
  } catch (error) {
    emptyFailure = error;
  }
  try {
    validatePptxPresentationBounds({ slideCount: PPTX_SLIDE_LIMIT + 1 });
  } catch (error) {
    largeFailure = error;
  }

  expect((emptyFailure as PptxRuntimeFailure).kind).toBe("malformed");
  expect((largeFailure as PptxRuntimeFailure).kind).toBe("resource_limit");
});

test("maps stable OOXML password, resource, malformed, and fallback errors", () => {
  const password = normalizePptxRuntimeError({ code: "encrypted" });
  const image = normalizePptxRuntimeError({
    code: "ooxml-decoded-image-limit",
  });
  const malformed = normalizePptxRuntimeError({ code: "not-ooxml" });
  const unsupported = normalizePptxRuntimeError({
    code: "unsupported-encryption",
  });

  expect(password instanceof PptxPasswordFailure).toBe(true);
  expect((password as PptxPasswordFailure).incorrect).toBe(false);
  expect((image as PptxRuntimeFailure).kind).toBe("resource_limit");
  expect((malformed as PptxRuntimeFailure).kind).toBe("malformed");
  expect((unsupported as PptxRuntimeFailure).kind).toBe("external_only");
});
