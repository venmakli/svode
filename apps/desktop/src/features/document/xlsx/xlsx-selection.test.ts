import { expect, test } from "bun:test";
import type { XlsxSelectionContext } from "@silurus/ooxml/xlsx";

import { inspectActiveXlsxCell, nextXlsxCellOnEnter } from "./xlsx-selection";

test("inspects the active cell using displayed cached text and source formula", () => {
  const context = {
    cells: [
      {
        address: { col: 28, row: 4 },
        displayText: "$1,250.00",
        formula: "SUM(B4:AA4)",
        value: 1250,
        valueType: "number",
      },
    ],
    format: "xlsx",
    kind: "range",
    coordinateCountUpperBound: 1,
    maxCells: 10_000,
    maxTextCharacters: 1_000_000,
    selection: {
      activeAreaIndex: 0,
      activeCell: { col: 28, row: 4 },
      areas: [{ bottom: 4, kind: "cells", left: 28, right: 28, top: 4 }],
      extensionAnchor: { col: 28, row: 4 },
    },
    sheetIndex: 0,
    sheetName: "Sheet 1",
    textCharacters: 9,
    truncated: false,
    truncationReasons: [],
  } as XlsxSelectionContext;

  expect(inspectActiveXlsxCell(context)).toEqual({
    cellRef: "AB4",
    displayValue: "$1,250.00",
    formula: "=SUM(B4:AA4)",
  });
});

test("moves Enter selection down without crossing the row limit", () => {
  expect(nextXlsxCellOnEnter({ row: 4, col: 28 }, 100_000)).toEqual({
    row: 5,
    col: 28,
  });
  expect(nextXlsxCellOnEnter({ row: 100_000, col: 28 }, 100_000)).toEqual({
    row: 100_000,
    col: 28,
  });
});
