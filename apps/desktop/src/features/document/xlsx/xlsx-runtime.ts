import type { Worksheet, XlsxWorkbook } from "@silurus/ooxml/xlsx";

import type { DocumentRuntimeSession } from "../model/session";
import type { DocumentFailureKind } from "../model/types";

export const XLSX_SHEET_LIMIT = 256;
export const XLSX_USED_ROW_LIMIT = 100_000;
export const XLSX_USED_COLUMN_LIMIT = 2_048;
export const XLSX_LOAD_TIMEOUT_MS = 30_000;
export const XLSX_DECODED_IMAGE_BUDGET = 64 * 1024 * 1024;
export const XLSX_RESOURCE_LIMITS = {
  maxArchiveEntries: 2_048,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxTotalInflatedBytes: 96 * 1024 * 1024,
} as const;
export const XLSX_IMAGE_RESOURCES = {
  decodedByteBudget: XLSX_DECODED_IMAGE_BUDGET,
  strategy: "strict",
} as const;

type XlsxRuntime = typeof import("@silurus/ooxml/xlsx");
type XlsxRenderMode = "main" | "worker";

export interface XlsxRenderCapabilities {
  bitmapRenderer: boolean;
  offscreenCanvas: boolean;
  worker: boolean;
}

let xlsxRuntimePromise: Promise<XlsxRuntime> | null = null;

export class XlsxRuntimeFailure extends Error {
  constructor(
    readonly kind: DocumentFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "XlsxRuntimeFailure";
  }
}

export class XlsxPasswordFailure extends Error {
  constructor(readonly incorrect: boolean) {
    super(
      incorrect ? "XLSX password is incorrect" : "XLSX requires a password",
    );
    this.name = "XlsxPasswordFailure";
  }
}

export async function getXlsxRuntime() {
  xlsxRuntimePromise ??= import("@silurus/ooxml/xlsx");
  return xlsxRuntimePromise;
}

export async function openXlsxWorkbook({
  bytes,
  onLoading,
  password,
  session,
}: {
  bytes: Uint8Array;
  onLoading(progress: number): void;
  password?: string;
  session: DocumentRuntimeSession;
}) {
  onLoading(0.4);
  const runtime = await getXlsxRuntime();
  if (session.signal.aborted) throw new XlsxAbortError();

  onLoading(0.5);
  const source = Uint8Array.from(bytes).buffer;
  const loading = runtime.XlsxWorkbook.load(source, {
    mode: selectXlsxRenderMode(getXlsxRenderCapabilities()),
    password,
    resourceLimits: XLSX_RESOURCE_LIMITS,
    useGoogleFonts: false,
    workerTimeoutMs: XLSX_LOAD_TIMEOUT_MS,
  });

  let workbook: XlsxWorkbook;
  try {
    workbook = await waitForXlsxLoad(loading, session);
  } catch (error) {
    throw normalizeXlsxRuntimeError(error);
  }

  const unregisterWorkbook = session.addDisposer(() => workbook.destroy());
  try {
    await validateXlsxWorkbookBounds(workbook, session.signal, onLoading);
  } catch (error) {
    unregisterWorkbook();
    if (!session.signal.aborted) workbook.destroy();
    throw normalizeXlsxRuntimeError(error);
  }

  onLoading(1);
  return workbook;
}

export async function validateXlsxWorkbookBounds(
  workbook: Pick<XlsxWorkbook, "getWorksheet" | "sheetCount">,
  signal: AbortSignal,
  onLoading: (progress: number) => void = () => undefined,
) {
  if (workbook.sheetCount < 1) {
    throw new XlsxRuntimeFailure(
      "malformed",
      "XLSX does not contain a worksheet",
    );
  }
  if (workbook.sheetCount > XLSX_SHEET_LIMIT) {
    throw new XlsxRuntimeFailure(
      "resource_limit",
      `XLSX contains ${workbook.sheetCount} sheets; the preview limit is ${XLSX_SHEET_LIMIT}`,
    );
  }

  for (let sheetIndex = 0; sheetIndex < workbook.sheetCount; sheetIndex += 1) {
    if (signal.aborted) throw new XlsxAbortError();
    const worksheet = await workbook.getWorksheet(sheetIndex);
    assertWorksheetBounds(worksheet);
    onLoading(
      0.55 + ((sheetIndex + 1) / Math.max(workbook.sheetCount, 1)) * 0.35,
    );
  }
}

export function selectXlsxRenderMode({
  bitmapRenderer,
  offscreenCanvas,
  worker,
}: XlsxRenderCapabilities): XlsxRenderMode {
  return worker && offscreenCanvas && bitmapRenderer ? "worker" : "main";
}

export function normalizeXlsxRuntimeError(error: unknown): Error {
  if (
    error instanceof XlsxRuntimeFailure ||
    error instanceof XlsxPasswordFailure ||
    error instanceof XlsxAbortError
  ) {
    return error;
  }

  const code = errorCode(error);
  if (code === "encrypted" || code === "invalid-password") {
    return new XlsxPasswordFailure(code === "invalid-password");
  }
  if (code === "ooxml-resource-limit" || code === "ooxml-decoded-image-limit") {
    return new XlsxRuntimeFailure("resource_limit", errorMessage(error));
  }
  if (code === "unsupported-encryption" || code === "legacy-binary-format") {
    return new XlsxRuntimeFailure("external_only", errorMessage(error));
  }
  if (code === "not-ooxml" || code === "parser-crashed") {
    return new XlsxRuntimeFailure("malformed", errorMessage(error));
  }
  return new XlsxRuntimeFailure("renderer_error", errorMessage(error));
}

export function isXlsxAbortError(error: unknown) {
  return error instanceof XlsxAbortError || errorCode(error) === "AbortError";
}

function assertWorksheetBounds(worksheet: Worksheet) {
  let maxRow = 0;
  let maxColumn = 0;

  for (const row of worksheet.rows) {
    maxRow = Math.max(maxRow, row.index);
    for (const cell of row.cells) {
      maxRow = Math.max(maxRow, cell.row);
      maxColumn = Math.max(maxColumn, cell.col);
    }
  }
  for (const merge of worksheet.mergeCells) {
    maxRow = Math.max(maxRow, merge.bottom);
    maxColumn = Math.max(maxColumn, merge.right);
  }

  if (maxRow > XLSX_USED_ROW_LIMIT) {
    throw new XlsxRuntimeFailure(
      "resource_limit",
      `XLSX sheet “${worksheet.name}” uses row ${maxRow}; the preview limit is ${XLSX_USED_ROW_LIMIT}`,
    );
  }
  if (maxColumn > XLSX_USED_COLUMN_LIMIT) {
    throw new XlsxRuntimeFailure(
      "resource_limit",
      `XLSX sheet “${worksheet.name}” uses column ${maxColumn}; the preview limit is ${XLSX_USED_COLUMN_LIMIT}`,
    );
  }
}

async function waitForXlsxLoad(
  loading: Promise<XlsxWorkbook>,
  session: DocumentRuntimeSession,
) {
  return new Promise<XlsxWorkbook>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      session.signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new XlsxAbortError());
    const timeout = setTimeout(
      () =>
        fail(
          new XlsxRuntimeFailure(
            "resource_limit",
            "XLSX preview exceeded the 30 second load limit",
          ),
        ),
      XLSX_LOAD_TIMEOUT_MS,
    );

    session.signal.addEventListener("abort", abort, { once: true });
    if (session.signal.aborted) abort();

    void loading.then(
      (workbook) => {
        if (settled) {
          workbook.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(workbook);
      },
      (error) => fail(error),
    );
  });
}

class XlsxAbortError extends Error {
  constructor() {
    super("XLSX loading was aborted");
    this.name = "AbortError";
  }
}

function errorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getXlsxRenderCapabilities(): XlsxRenderCapabilities {
  const worker = typeof Worker !== "undefined";
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";

  if (!worker || !offscreenCanvas || typeof document === "undefined") {
    return { bitmapRenderer: false, offscreenCanvas, worker };
  }

  let bitmap: ImageBitmap | undefined;
  try {
    const context = document
      .createElement("canvas")
      .getContext("bitmaprenderer");
    if (!context) {
      return { bitmapRenderer: false, offscreenCanvas, worker };
    }

    const probe = new OffscreenCanvas(1, 1);
    bitmap = probe.transferToImageBitmap();
    context.transferFromImageBitmap(bitmap);
    bitmap = undefined;
    return { bitmapRenderer: true, offscreenCanvas, worker };
  } catch {
    bitmap?.close();
    return { bitmapRenderer: false, offscreenCanvas, worker };
  }
}
