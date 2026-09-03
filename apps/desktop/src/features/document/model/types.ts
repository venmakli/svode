import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DocxDocument } from "@silurus/ooxml/docx";
import type { XlsxSelectionState, XlsxWorkbook } from "@silurus/ooxml/xlsx";

export type DocumentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "doc"
  | "xls"
  | "ppt"
  | "docm"
  | "xlsm"
  | "pptm"
  | "odt"
  | "ods"
  | "odp";

export interface DocumentTarget {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  path: string;
}

export interface DocumentSourceDescriptor {
  format: DocumentFormat;
  sizeBytes: number;
  generation: string;
}

export type DocumentFailureKind =
  | "resource_limit"
  | "malformed"
  | "renderer_error"
  | "source_changed"
  | "source_missing"
  | "external_only";

export interface DocumentFailure {
  kind: DocumentFailureKind;
  detail?: string;
  limitBytes?: number;
  actualBytes?: number;
}

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

export interface PdfTextIndex {
  pages: readonly PdfTextPage[];
  complete: boolean;
  truncated: boolean;
}

export interface DocxTextIndex {
  text: string;
  complete: boolean;
  truncated: boolean;
}

export interface XlsxTextCell {
  sheetIndex: number;
  sheetName: string;
  cellRef: string;
  displayValue: string;
  formula?: string;
}

export interface XlsxTextIndex {
  sheetNames: readonly string[];
  cells: readonly XlsxTextCell[];
  complete: boolean;
  truncated: boolean;
}

export type DocumentZoomMode = "custom" | "page" | "width";
export type PdfZoomMode = DocumentZoomMode;

export interface DocumentViewState {
  pageNumber: number;
  sheetIndex: number;
  spreadsheetSelection: XlsxSelectionState | null;
  zoom: number;
  zoomMode: DocumentZoomMode;
  rotation: 0 | 90 | 180 | 270;
  thumbnailsOpen: boolean;
  findQuery: string;
  activeFindIndex: number;
}

export const DEFAULT_DOCUMENT_VIEW_STATE: DocumentViewState = {
  activeFindIndex: 0,
  findQuery: "",
  pageNumber: 1,
  sheetIndex: 0,
  spreadsheetSelection: null,
  rotation: 0,
  thumbnailsOpen: true,
  zoom: 1,
  zoomMode: "width",
};

export function createDocumentViewState(
  format: DocumentFormat | null = null,
): DocumentViewState {
  return {
    ...DEFAULT_DOCUMENT_VIEW_STATE,
    zoomMode: format === "xlsx" ? "custom" : "width",
  };
}

export type DocumentSessionState =
  | { phase: "loading"; progress: number }
  | {
      phase: "password";
      format: "pdf" | "docx" | "xlsx";
      incorrect: boolean;
    }
  | {
      phase: "ready";
      format: "pdf";
      descriptor: DocumentSourceDescriptor;
      pdf: PDFDocumentProxy;
      textIndex: PdfTextIndex;
    }
  | {
      phase: "ready";
      format: "docx";
      descriptor: DocumentSourceDescriptor;
      docx: DocxDocument;
      textIndex: DocxTextIndex;
    }
  | {
      phase: "ready";
      format: "xlsx";
      descriptor: DocumentSourceDescriptor;
      workbook: XlsxWorkbook;
      textIndex: XlsxTextIndex;
    }
  | { phase: "failed"; failure: DocumentFailure };

export function documentTargetKey(target: DocumentTarget) {
  return `${normalizeRuntimePath(target.spacePath)}\0${target.path}`;
}

export function documentFormatFromPath(path: string): DocumentFormat | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "pdf":
    case "docx":
    case "xlsx":
    case "pptx":
    case "doc":
    case "xls":
    case "ppt":
    case "docm":
    case "xlsm":
    case "pptm":
    case "odt":
    case "ods":
    case "odp":
      return extension;
    default:
      return null;
  }
}

export function documentHasInlinePreview(format: DocumentFormat) {
  return format === "pdf" || format === "docx" || format === "xlsx";
}

export function normalizeRuntimePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}
