import { expect, test } from "bun:test";

import {
  DOCX_DECODED_IMAGE_BUDGET,
  DOCX_IMAGE_RESOURCES,
  DOCX_LOAD_TIMEOUT_MS,
  DOCX_PAGE_LIMIT,
  DOCX_RESOURCE_LIMITS,
  DocxPasswordFailure,
  DocxRuntimeFailure,
  normalizeDocxRuntimeError,
  selectDocxRenderMode,
} from "./docx-runtime";

test("freezes the DOCX parser, image, page, and time budgets", () => {
  expect(DOCX_RESOURCE_LIMITS).toEqual({
    maxArchiveEntries: 2_048,
    maxArchiveEntryBytes: 32 * 1024 * 1024,
    maxTotalInflatedBytes: 96 * 1024 * 1024,
  });
  expect(DOCX_IMAGE_RESOURCES).toEqual({
    decodedByteBudget: DOCX_DECODED_IMAGE_BUDGET,
    strategy: "strict",
  });
  expect(DOCX_DECODED_IMAGE_BUDGET).toBe(64 * 1024 * 1024);
  expect(DOCX_PAGE_LIMIT).toBe(2_000);
  expect(DOCX_LOAD_TIMEOUT_MS).toBe(30_000);
});

test("uses worker rendering only when the complete bitmap path is available", () => {
  expect(
    selectDocxRenderMode({
      bitmapRenderer: true,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("worker");
  expect(
    selectDocxRenderMode({
      bitmapRenderer: false,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("main");
  expect(
    selectDocxRenderMode({
      bitmapRenderer: true,
      offscreenCanvas: false,
      worker: true,
    }),
  ).toBe("main");
  expect(
    selectDocxRenderMode({
      bitmapRenderer: true,
      offscreenCanvas: true,
      worker: false,
    }),
  ).toBe("main");
});

test("maps stable OOXML password and resource errors", () => {
  const password = normalizeDocxRuntimeError({ code: "encrypted" });
  const incorrect = normalizeDocxRuntimeError({ code: "invalid-password" });
  const archive = normalizeDocxRuntimeError({
    code: "ooxml-resource-limit",
  });
  const image = normalizeDocxRuntimeError({
    code: "ooxml-decoded-image-limit",
  });

  expect(password instanceof DocxPasswordFailure).toBe(true);
  expect((password as DocxPasswordFailure).incorrect).toBe(false);
  expect((incorrect as DocxPasswordFailure).incorrect).toBe(true);
  expect((archive as DocxRuntimeFailure).kind).toBe("resource_limit");
  expect((image as DocxRuntimeFailure).kind).toBe("resource_limit");
});

test("keeps malformed and unsupported encryption failures distinct", () => {
  const malformed = normalizeDocxRuntimeError({ code: "not-ooxml" });
  const unsupported = normalizeDocxRuntimeError({
    code: "unsupported-encryption",
  });

  expect((malformed as DocxRuntimeFailure).kind).toBe("malformed");
  expect((unsupported as DocxRuntimeFailure).kind).toBe("external_only");
});
