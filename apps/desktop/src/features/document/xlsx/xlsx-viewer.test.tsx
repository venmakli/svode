import { expect, test } from "bun:test";
import type { XlsxWorkbook } from "@silurus/ooxml/xlsx";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { DEFAULT_DOCUMENT_VIEW_STATE } from "../model/types";
import { XlsxCellInspector, XlsxViewer } from "./xlsx-viewer";

test("XLSX surface exposes compact controls, inspector, and bounded sheet tabs", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <XlsxViewer
        externalOpenError={null}
        onOpenExternal={() => undefined}
        onRegisterRendererDisposer={() => () => undefined}
        onRenderError={() => undefined}
        onViewStateChange={() => undefined}
        title="forecast.xlsx"
        viewState={DEFAULT_DOCUMENT_VIEW_STATE}
        workbook={
          {
            sheetCount: 2,
            sheetNames: ["Forecast", "Actuals"],
          } as XlsxWorkbook
        }
      />
    </TooltipProvider>,
  );

  expect(html.includes('data-document-viewer="xlsx"')).toBe(true);
  expect(html.includes("Read-only preview")).toBe(true);
  expect(html.includes("Select a cell to inspect")).toBe(true);
  expect(html.includes("Forecast")).toBe(true);
  expect(html.includes("Actuals")).toBe(true);
  for (const label of [
    "Zoom out",
    "Zoom in",
    "Fit to width",
    "Find in document",
    "Open externally",
    "Workbook sheets",
  ]) {
    expect(html.includes(label)).toBe(true);
  }
});

test("XLSX inspector keeps value compact and gives formula the remaining row", () => {
  const html = renderToStaticMarkup(
    <XlsxCellInspector
      inspection={{
        cellRef: "G12",
        displayValue: "39.7%",
        formula: "='Data'!$C$9/'Data'!$C$4-1",
      }}
    />,
  );

  expect(html.includes("max-w-80")).toBe(true);
  expect(html.includes("min-w-0 flex-1 items-center")).toBe(true);
  expect(html.indexOf("39.7%") < html.indexOf("Formula")).toBe(true);
});
