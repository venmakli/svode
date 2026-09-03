import type { PDFDocumentProxy } from "pdfjs-dist";

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

export type PdfZoomMode = "custom" | "page" | "width";

export interface DocumentViewState {
  pageNumber: number;
  zoom: number;
  zoomMode: PdfZoomMode;
  rotation: 0 | 90 | 180 | 270;
  thumbnailsOpen: boolean;
  findQuery: string;
  activeFindIndex: number;
}

export const DEFAULT_DOCUMENT_VIEW_STATE: DocumentViewState = {
  activeFindIndex: 0,
  findQuery: "",
  pageNumber: 1,
  rotation: 0,
  thumbnailsOpen: true,
  zoom: 1,
  zoomMode: "width",
};

export type DocumentSessionState =
  | { phase: "loading"; progress: number }
  | { phase: "password"; incorrect: boolean }
  | {
      phase: "ready";
      descriptor: DocumentSourceDescriptor;
      pdf: PDFDocumentProxy;
      textIndex: PdfTextIndex;
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
  return format === "pdf";
}

export function normalizeRuntimePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}
