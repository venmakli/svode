import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import { ensureReadableStreamAsyncIterator } from "@/platform/document/pdf-compat";

import type { DocumentRuntimeSession } from "../model/session";

const PDF_PAGE_LIMIT = 2_000;
const PDF_IMAGE_PIXEL_LIMIT = 16_777_216;
const PDF_LOAD_TIMEOUT_MS = 30_000;

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfJsViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let pdfJsViewerPromise: Promise<PdfJsViewerModule> | null = null;

export class PdfRuntimeFailure extends Error {
  constructor(
    readonly kind: "malformed" | "resource_limit" | "renderer_error",
    message: string,
  ) {
    super(message);
  }
}

export async function openPdfDocument({
  bytes,
  onLoading,
  onPassword,
  session,
}: {
  bytes: Uint8Array;
  onLoading(progress: number): void;
  onPassword(incorrect: boolean): void;
  session: DocumentRuntimeSession;
}): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJsRuntime();
  if (session.signal.aborted) throw abortError();

  const loadingTask = pdfjs.getDocument({
    cMapPacked: true,
    cMapUrl: pdfAssetUrl("cmaps"),
    data: bytes,
    enableXfa: false,
    iccUrl: pdfAssetUrl("iccs"),
    maxImageSize: PDF_IMAGE_PIXEL_LIMIT,
    standardFontDataUrl: pdfAssetUrl("standard_fonts"),
    stopAtErrors: true,
    useSystemFonts: true,
    useWasm: true,
    useWorkerFetch: true,
    wasmUrl: pdfAssetUrl("wasm"),
  });
  session.addDisposer(() => loadingTask.destroy());
  loadingTask.onProgress = ({
    loaded,
    total,
  }: {
    loaded: number;
    total: number;
  }) => {
    if (!session.signal.aborted && total > 0) {
      onLoading(0.35 + Math.min(loaded / total, 1) * 0.35);
    }
  };
  loadingTask.onPassword = (
    updatePassword: (password: string) => void,
    reason: number,
  ) => {
    if (session.signal.aborted) return;
    session.setPasswordHandler((password) => {
      onLoading(0.7);
      updatePassword(password);
    });
    onPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
  };

  try {
    const pdf = await withLoadBoundary(loadingTask, session);
    session.setPasswordHandler(null);
    if (pdf.numPages > PDF_PAGE_LIMIT) {
      throw new PdfRuntimeFailure(
        "resource_limit",
        `PDF contains ${pdf.numPages} pages; the preview limit is ${PDF_PAGE_LIMIT}`,
      );
    }
    onLoading(1);
    return pdf;
  } catch (error) {
    session.setPasswordHandler(null);
    await loadingTask.destroy().catch(() => undefined);
    if (error instanceof PdfRuntimeFailure || isAbortError(error)) throw error;
    if (
      error instanceof Error &&
      [
        "InvalidPDFException",
        "MissingPDFException",
        "UnexpectedResponseException",
      ].includes(error.name)
    ) {
      throw new PdfRuntimeFailure("malformed", error.message);
    }
    throw new PdfRuntimeFailure(
      "renderer_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function getPdfJsRuntime() {
  ensureReadableStreamAsyncIterator();
  pdfJsPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfJsPromise;
}

export function getPdfJsViewerRuntime() {
  pdfJsViewerPromise ??= getPdfJsRuntime().then((pdfjs) => {
    (
      globalThis as typeof globalThis & {
        pdfjsLib: PdfJsModule;
      }
    ).pdfjsLib = pdfjs;
    return import("pdfjs-dist/web/pdf_viewer.mjs");
  });
  return pdfJsViewerPromise;
}

function pdfAssetUrl(directory: string) {
  return new URL(`/vendor/pdfjs/${directory}/`, window.location.origin).href;
}

function withLoadBoundary(
  loadingTask: PDFDocumentLoadingTask,
  session: DocumentRuntimeSession,
) {
  let loadTimeout: number | undefined;
  const boundary = Promise.race([
    loadingTask.promise,
    new Promise<never>((_, reject) => {
      loadTimeout = window.setTimeout(() => {
        reject(
          new PdfRuntimeFailure(
            "resource_limit",
            "PDF preview exceeded the 30 second initial-load limit",
          ),
        );
      }, PDF_LOAD_TIMEOUT_MS);
    }),
    new Promise<never>((_, reject) => {
      session.signal.addEventListener("abort", () => reject(abortError()), {
        once: true,
      });
    }),
  ]);
  session.addDisposer(() => window.clearTimeout(loadTimeout));
  return boundary.finally(() => window.clearTimeout(loadTimeout));
}

function abortError() {
  return new DOMException("Document session aborted", "AbortError");
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
