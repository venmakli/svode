import { expect, test } from "bun:test";
import type { Worksheet } from "@silurus/ooxml/xlsx";

import {
  normalizeXlsxRuntimeError,
  selectXlsxRenderMode,
  validateXlsxWorkbookBounds,
  XLSX_DECODED_IMAGE_BUDGET,
  XLSX_IMAGE_RESOURCES,
  XLSX_LOAD_TIMEOUT_MS,
  XLSX_RESOURCE_LIMITS,
  XLSX_SHEET_LIMIT,
  XLSX_USED_COLUMN_LIMIT,
  XLSX_USED_ROW_LIMIT,
  XlsxPasswordFailure,
  XlsxRuntimeFailure,
} from "./xlsx-runtime";

test("freezes XLSX archive, image, sheet, used-range, and time budgets", () => {
  expect(XLSX_RESOURCE_LIMITS).toEqual({
    maxArchiveEntries: 2_048,
    maxArchiveEntryBytes: 32 * 1024 * 1024,
    maxTotalInflatedBytes: 96 * 1024 * 1024,
  });
  expect(XLSX_IMAGE_RESOURCES).toEqual({
    decodedByteBudget: XLSX_DECODED_IMAGE_BUDGET,
    strategy: "strict",
  });
  expect(XLSX_DECODED_IMAGE_BUDGET).toBe(64 * 1024 * 1024);
  expect(XLSX_SHEET_LIMIT).toBe(256);
  expect(XLSX_USED_ROW_LIMIT).toBe(100_000);
  expect(XLSX_USED_COLUMN_LIMIT).toBe(2_048);
  expect(XLSX_LOAD_TIMEOUT_MS).toBe(30_000);
});

test("uses worker rendering only when the complete bitmap path is available", () => {
  expect(
    selectXlsxRenderMode({
      bitmapRenderer: true,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("worker");
  expect(
    selectXlsxRenderMode({
      bitmapRenderer: false,
      offscreenCanvas: true,
      worker: true,
    }),
  ).toBe("main");
});

test("rejects sheets whose used range crosses row or column ceilings", async () => {
  const rowWorkbook = workbookWith(
    worksheet({ col: 1, row: XLSX_USED_ROW_LIMIT + 1 }),
  );
  const columnWorkbook = workbookWith(
    worksheet({ col: XLSX_USED_COLUMN_LIMIT + 1, row: 1 }),
  );

  await expectRuntimeLimit(rowWorkbook);
  await expectRuntimeLimit(columnWorkbook);
});

test("rejects empty and over-limit workbook sheet sets before rendering", async () => {
  let emptyFailure: unknown;
  let largeFailure: unknown;
  try {
    await validateXlsxWorkbookBounds(
      {
        getWorksheet: async () => worksheet({ col: 1, row: 1 }),
        sheetCount: 0,
      },
      new AbortController().signal,
    );
  } catch (error) {
    emptyFailure = error;
  }
  try {
    await validateXlsxWorkbookBounds(
      {
        getWorksheet: async () => worksheet({ col: 1, row: 1 }),
        sheetCount: XLSX_SHEET_LIMIT + 1,
      },
      new AbortController().signal,
    );
  } catch (error) {
    largeFailure = error;
  }

  expect((emptyFailure as XlsxRuntimeFailure).kind).toBe("malformed");
  expect((largeFailure as XlsxRuntimeFailure).kind).toBe("resource_limit");
});

test("maps stable OOXML password, resource, malformed, and fallback errors", () => {
  const password = normalizeXlsxRuntimeError({ code: "encrypted" });
  const image = normalizeXlsxRuntimeError({
    code: "ooxml-decoded-image-limit",
  });
  const malformed = normalizeXlsxRuntimeError({ code: "not-ooxml" });
  const unsupported = normalizeXlsxRuntimeError({
    code: "unsupported-encryption",
  });

  expect(password instanceof XlsxPasswordFailure).toBe(true);
  expect((password as XlsxPasswordFailure).incorrect).toBe(false);
  expect((image as XlsxRuntimeFailure).kind).toBe("resource_limit");
  expect((malformed as XlsxRuntimeFailure).kind).toBe("malformed");
  expect((unsupported as XlsxRuntimeFailure).kind).toBe("external_only");
});

async function expectRuntimeLimit(workbook: ReturnType<typeof workbookWith>) {
  let failure: unknown;
  try {
    await validateXlsxWorkbookBounds(workbook, new AbortController().signal);
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof XlsxRuntimeFailure).toBe(true);
  expect((failure as XlsxRuntimeFailure).kind).toBe("resource_limit");
}

function workbookWith(sheet: Worksheet) {
  return {
    getWorksheet: async () => sheet,
    sheetCount: 1,
  };
}

function worksheet({ col, row }: { col: number; row: number }) {
  return {
    charts: [],
    colWidths: {},
    conditionalFormats: [],
    defaultColWidth: 8,
    defaultRowHeight: 15,
    freezeCols: 0,
    freezeRows: 0,
    images: [],
    mergeCells: [],
    name: "Sheet 1",
    rowHeights: {},
    rows: [
      {
        cells: [{ col, row, value: { type: "empty" } }],
        height: null,
        index: row,
      },
    ],
  } as Worksheet;
}
