import { expect, test } from "bun:test";
import type { Cell, Worksheet, XlsxWorkbook } from "@silurus/ooxml/xlsx";

import { extractXlsxText } from "./xlsx-text-index";

test("extracts sheet names, cached display values, formulas, and stable locators", async () => {
  const workbook = fixture([
    sheet("Revenue", [
      cell(1, 1, "Quarter"),
      cell(2, 1, "Total", "SUM(B2:B4)"),
    ]),
    sheet("Plan", [cell(1, 3, "Ready")]),
  ]);

  const index = await extractXlsxText(workbook, new AbortController().signal);

  expect(index.complete).toBe(true);
  expect(index.sheetNames).toEqual(["Revenue", "Plan"]);
  expect(index.cells).toEqual([
    {
      cellRef: "A1",
      displayValue: "Quarter",
      formula: undefined,
      sheetIndex: 0,
      sheetName: "Revenue",
    },
    {
      cellRef: "B1",
      displayValue: "Total",
      formula: "=SUM(B2:B4)",
      sheetIndex: 0,
      sheetName: "Revenue",
    },
    {
      cellRef: "A3",
      displayValue: "Ready",
      formula: undefined,
      sheetIndex: 1,
      sheetName: "Plan",
    },
  ]);
});

test("stops before a cell that would cross the extraction character budget", async () => {
  const workbook = fixture([sheet("S", [cell(1, 1, "1234")])]);
  const index = await extractXlsxText(
    workbook,
    new AbortController().signal,
    4,
  );

  expect(index.cells).toEqual([]);
  expect(index.complete).toBe(false);
  expect(index.truncated).toBe(true);
});

function fixture(sheets: Worksheet[]) {
  return {
    cellText: (_worksheet: Worksheet, value: Cell) =>
      value.value.type === "text" ? value.value.text : "",
    getWorksheet: async (index: number) => sheets[index],
    sheetCount: sheets.length,
    sheetNames: sheets.map((value) => value.name),
  } as Pick<
    XlsxWorkbook,
    "cellText" | "getWorksheet" | "sheetCount" | "sheetNames"
  >;
}

function sheet(name: string, cells: Cell[]) {
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
    name,
    rowHeights: {},
    rows: cells.map((value) => ({
      cells: [value],
      height: null,
      index: value.row,
    })),
  } as Worksheet;
}

function cell(col: number, row: number, text: string, formula?: string) {
  return { col, formula, row, value: { text, type: "text" } } as Cell;
}
