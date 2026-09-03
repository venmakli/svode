import { expect, test } from "bun:test";
import type { XlsxWorkbook } from "@silurus/ooxml/xlsx";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { DEFAULT_DOCUMENT_VIEW_STATE } from "../model/types";
import { XlsxViewer } from "./xlsx-viewer";

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
