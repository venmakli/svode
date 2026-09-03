import type { Cell, XlsxWorkbook } from "@silurus/ooxml/xlsx";

import type { XlsxTextCell, XlsxTextIndex } from "../model/types";

export const XLSX_TEXT_LIMIT = 1_000_000;

export async function extractXlsxText(
  workbook: Pick<
    XlsxWorkbook,
    "cellText" | "getWorksheet" | "sheetCount" | "sheetNames"
  >,
  signal: AbortSignal,
  limit = XLSX_TEXT_LIMIT,
): Promise<XlsxTextIndex> {
  const sheetNames: string[] = [];
  const cells: XlsxTextCell[] = [];
  let characters = 0;
  let truncated = false;

  for (let sheetIndex = 0; sheetIndex < workbook.sheetCount; sheetIndex += 1) {
    if (signal.aborted || truncated) break;
    const sheetName =
      workbook.sheetNames[sheetIndex] ?? `Sheet ${sheetIndex + 1}`;
    if (!fitsItem(sheetName, characters, limit)) {
      truncated = true;
      break;
    }
    sheetNames.push(sheetName);
    characters += sheetName.length;

    const worksheet = await workbook.getWorksheet(sheetIndex);
    for (const row of worksheet.rows) {
      for (const cell of row.cells) {
        if (signal.aborted) break;
        const displayValue = workbook.cellText(worksheet, cell);
        const formula = sourceFormula(cell);
        if (!displayValue && !formula) continue;
        const itemLength = displayValue.length + (formula?.length ?? 0);
        if (!fitsItemLength(itemLength, characters, limit)) {
          truncated = true;
          break;
        }
        cells.push({
          cellRef: cellReference(cell),
          displayValue,
          formula,
          sheetIndex,
          sheetName,
        });
        characters += itemLength;
      }
      if (signal.aborted || truncated) break;
    }
  }

  return {
    cells,
    complete:
      !signal.aborted &&
      !truncated &&
      sheetNames.length === workbook.sheetCount,
    sheetNames,
    truncated,
  };
}

export function sourceFormula(cell: Pick<Cell, "formula">) {
  const formula = cell.formula?.trim();
  if (!formula) return undefined;
  return formula.startsWith("=") ? formula : `=${formula}`;
}

export function cellReference(cell: Pick<Cell, "col" | "row">) {
  return `${columnLabel(cell.col)}${cell.row}`;
}

function columnLabel(column: number) {
  let current = Math.max(1, Math.trunc(column));
  let label = "";
  while (current > 0) {
    current -= 1;
    label = String.fromCharCode(65 + (current % 26)) + label;
    current = Math.floor(current / 26);
  }
  return label;
}

function fitsItem(value: string, current: number, limit: number) {
  return fitsItemLength(value.length, current, limit);
}

function fitsItemLength(length: number, current: number, limit: number) {
  return length <= Math.max(limit - current, 0);
}
