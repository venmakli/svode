import type { CSSProperties, ReactNode } from "react";
import type { XlsxWorkbook } from "@silurus/ooxml/xlsx";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState } from "../model/types";
import { XlsxToolbar } from "./xlsx-toolbar";
import { useXlsxSheetViewer } from "./use-xlsx-sheet-viewer";
import type { XlsxCellInspection } from "./xlsx-selection";

const XLSX_THEME_STYLE = {
  "--ooxml-xlsx-chrome-accent": "var(--primary)",
  "--ooxml-xlsx-chrome-background": "var(--muted)",
  "--ooxml-xlsx-chrome-border": "var(--border)",
  "--ooxml-xlsx-chrome-selection-background": "var(--accent)",
  "--ooxml-xlsx-chrome-surface": "var(--background)",
  "--ooxml-xlsx-chrome-surface-muted": "var(--muted)",
  "--ooxml-xlsx-chrome-text": "var(--foreground)",
  "--ooxml-xlsx-chrome-text-muted": "var(--muted-foreground)",
  "--ooxml-xlsx-focus-ring": "var(--ring)",
} as CSSProperties;

export function XlsxViewer({
  externalOpenError,
  onOpenExternal,
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  title,
  toolbarActions,
  viewState,
  workbook,
}: {
  externalOpenError: string | null;
  onOpenExternal(): void;
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
  workbook: XlsxWorkbook;
}) {
  const {
    canvasRef,
    cellInspection,
    findMatches,
    fitWidth,
    goToSheet,
    navigateFind,
    setZoom,
  } = useXlsxSheetViewer({
    onRegisterRendererDisposer,
    onRenderError,
    onViewStateChange,
    viewState,
    viewportLabel: m.document_xlsx_viewport(),
    workbook,
  });
  const activeSheet = String(viewState.sheetIndex);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-document-viewer="xlsx"
      aria-label={`${title}: ${m.document_read_only_preview()}`}
    >
      <XlsxToolbar
        findMatches={findMatches}
        fitWidth={fitWidth}
        navigateFind={navigateFind}
        onOpenExternal={onOpenExternal}
        onViewStateChange={onViewStateChange}
        setZoom={setZoom}
        title={title}
        toolbarActions={toolbarActions}
        viewState={viewState}
      />
      {externalOpenError ? (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <AlertDescription>
            {m.document_external_open_error()}
          </AlertDescription>
        </Alert>
      ) : null}
      <XlsxCellInspector inspection={cellInspection} />
      <Tabs
        className="min-h-0 flex-1 gap-0 overflow-hidden"
        value={activeSheet}
        onValueChange={(value) => goToSheet(Number(value))}
      >
        <TabsContent
          forceMount
          className="relative min-h-0 overflow-hidden bg-muted/40"
          value={activeSheet}
        >
          <div
            className="absolute inset-0 overflow-hidden"
            style={XLSX_THEME_STYLE}
          >
            <canvas ref={canvasRef} className="size-full">
              {m.document_xlsx_canvas_fallback()}
            </canvas>
          </div>
        </TabsContent>
        <div className="shrink-0 overflow-x-auto border-t bg-background px-1">
          <TabsList
            aria-label={m.document_xlsx_sheet_tabs()}
            className="h-8 max-w-none justify-start rounded-none p-0"
            variant="line"
          >
            {workbook.sheetNames.map((sheetName, sheetIndex) => (
              <TabsTrigger
                className="max-w-48 flex-none px-3"
                key={`${sheetName}-${sheetIndex}`}
                title={sheetName}
                value={String(sheetIndex)}
              >
                <span className="truncate">{sheetName}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
    </div>
  );
}

export function XlsxCellInspector({
  inspection,
}: {
  inspection: XlsxCellInspection | null;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b bg-background px-3 text-xs">
      <span className="w-14 shrink-0 font-medium tabular-nums text-foreground">
        {inspection?.cellRef ?? "—"}
      </span>
      {inspection ? (
        <>
          <div className="flex min-w-0 max-w-80 items-center gap-3">
            <span className="shrink-0 text-muted-foreground">
              {m.document_xlsx_cell_value()}
            </span>
            <span className="min-w-0 truncate" title={inspection.displayValue}>
              {inspection.displayValue || m.document_xlsx_empty_cell()}
            </span>
          </div>
          {inspection.formula ? (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="shrink-0 text-muted-foreground">
                {m.document_xlsx_cell_formula()}
              </span>
              <code
                className="min-w-0 flex-1 truncate text-foreground"
                title={inspection.formula}
              >
                {inspection.formula}
              </code>
            </div>
          ) : null}
        </>
      ) : (
        <span className="truncate text-muted-foreground">
          {m.document_xlsx_select_cell()}
        </span>
      )}
    </div>
  );
}
