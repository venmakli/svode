import type { CellAddress, XlsxSelectionContext } from "@silurus/ooxml/xlsx";

export interface XlsxCellInspection {
  cellRef: string;
  displayValue: string;
  formula?: string;
}

export function inspectActiveXlsxCell(
  context: XlsxSelectionContext | null,
): XlsxCellInspection | null {
  if (!context || context.kind !== "range") return null;
  const activeCell = context.selection.activeCell;
  const cell = context.cells.find(
    (candidate) =>
      candidate.address.row === activeCell.row &&
      candidate.address.col === activeCell.col,
  );
  return {
    cellRef: cellAddressReference(activeCell),
    displayValue: cell?.displayText ?? "",
    formula: normalizeFormula(cell?.formula),
  };
}

export function cellAddressReference(address: CellAddress) {
  let column = Math.max(1, Math.trunc(address.col));
  let label = "";
  while (column > 0) {
    column -= 1;
    label = String.fromCharCode(65 + (column % 26)) + label;
    column = Math.floor(column / 26);
  }
  return `${label}${Math.max(1, Math.trunc(address.row))}`;
}

export function nextXlsxCellOnEnter(
  address: CellAddress,
  rowLimit: number,
): CellAddress {
  return {
    col: Math.max(1, Math.trunc(address.col)),
    row: Math.min(Math.max(1, Math.trunc(address.row)) + 1, rowLimit),
  };
}

function normalizeFormula(formula: string | undefined) {
  const source = formula?.trim();
  if (!source) return undefined;
  return source.startsWith("=") ? source : `=${source}`;
}
