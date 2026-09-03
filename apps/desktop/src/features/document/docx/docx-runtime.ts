import type { DocxDocument } from "@silurus/ooxml/docx";

import type { DocumentFailureKind } from "../model/types";
import type { DocumentRuntimeSession } from "../model/session";

export const DOCX_PAGE_LIMIT = 2_000;
export const DOCX_LOAD_TIMEOUT_MS = 30_000;
export const DOCX_DECODED_IMAGE_BUDGET = 64 * 1024 * 1024;
export const DOCX_RESOURCE_LIMITS = {
  maxArchiveEntries: 2_048,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxTotalInflatedBytes: 96 * 1024 * 1024,
} as const;
export const DOCX_IMAGE_RESOURCES = {
  decodedByteBudget: DOCX_DECODED_IMAGE_BUDGET,
  strategy: "strict",
} as const;

type DocxRuntime = typeof import("@silurus/ooxml/docx");
type DocxRenderMode = "main" | "worker";

export interface DocxRenderCapabilities {
  bitmapRenderer: boolean;
  offscreenCanvas: boolean;
  worker: boolean;
}

let docxRuntimePromise: Promise<DocxRuntime> | null = null;

export class DocxRuntimeFailure extends Error {
  constructor(
    readonly kind: DocumentFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "DocxRuntimeFailure";
  }
}

export class DocxPasswordFailure extends Error {
  constructor(readonly incorrect: boolean) {
    super(incorrect ? "DOCX password is incorrect" : "DOCX requires a password");
    this.name = "DocxPasswordFailure";
  }
}

export async function getDocxRuntime() {
  docxRuntimePromise ??= import("@silurus/ooxml/docx");
  return docxRuntimePromise;
}

export async function openDocxDocument({
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
  const runtime = await getDocxRuntime();
  if (session.signal.aborted) throw new DocxAbortError();

  onLoading(0.5);
  const source = Uint8Array.from(bytes).buffer;
  const loading = runtime.DocxDocument.load(source, {
    mode: selectDocxRenderMode(getDocxRenderCapabilities()),
    onLayoutProgress: ({ committedUnits }) => {
      const measured = Math.log2(Math.max(committedUnits, 1) + 1) / 20;
      onLoading(Math.min(0.55 + measured, 0.9));
    },
    password,
    resourceLimits: DOCX_RESOURCE_LIMITS,
    sliceLayout: true,
    useGoogleFonts: false,
    workerTimeoutMs: DOCX_LOAD_TIMEOUT_MS,
  });

  let document: DocxDocument;
  try {
    document = await waitForDocxLoad(loading, session);
  } catch (error) {
    throw normalizeDocxRuntimeError(error);
  }

  if (document.pageCount > DOCX_PAGE_LIMIT) {
    document.destroy();
    throw new DocxRuntimeFailure(
      "resource_limit",
      `DOCX contains ${document.pageCount} pages; the preview limit is ${DOCX_PAGE_LIMIT}`,
    );
  }

  session.addDisposer(() => document.destroy());
  onLoading(1);
  return document;
}

export function selectDocxRenderMode({
  bitmapRenderer,
  offscreenCanvas,
  worker,
}: DocxRenderCapabilities): DocxRenderMode {
  return worker && offscreenCanvas && bitmapRenderer ? "worker" : "main";
}

export function normalizeDocxRuntimeError(error: unknown): Error {
  if (
    error instanceof DocxRuntimeFailure ||
    error instanceof DocxPasswordFailure ||
    error instanceof DocxAbortError
  ) {
    return error;
  }

  const code = errorCode(error);
  if (code === "encrypted" || code === "invalid-password") {
    return new DocxPasswordFailure(code === "invalid-password");
  }
  if (
    code === "ooxml-resource-limit" ||
    code === "ooxml-decoded-image-limit"
  ) {
    return new DocxRuntimeFailure("resource_limit", errorMessage(error));
  }
  if (code === "unsupported-encryption" || code === "legacy-binary-format") {
    return new DocxRuntimeFailure("external_only", errorMessage(error));
  }
  if (code === "not-ooxml" || code === "parser-crashed") {
    return new DocxRuntimeFailure("malformed", errorMessage(error));
  }
  return new DocxRuntimeFailure("renderer_error", errorMessage(error));
}

export function isDocxAbortError(error: unknown) {
  return error instanceof DocxAbortError || errorCode(error) === "AbortError";
}

async function waitForDocxLoad(
  loading: Promise<DocxDocument>,
  session: DocumentRuntimeSession,
) {
  return new Promise<DocxDocument>((resolve, reject) => {
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
    const abort = () => fail(new DocxAbortError());
    const timeout = setTimeout(
      () =>
        fail(
          new DocxRuntimeFailure(
            "resource_limit",
            "DOCX preview exceeded the 30 second load limit",
          ),
        ),
      DOCX_LOAD_TIMEOUT_MS,
    );

    session.signal.addEventListener("abort", abort, { once: true });
    if (session.signal.aborted) abort();

    void loading.then(
      (document) => {
        if (settled) {
          document.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(document);
      },
      (error) => fail(error),
    );
  });
}

class DocxAbortError extends Error {
  constructor() {
    super("DOCX loading was aborted");
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

function getDocxRenderCapabilities(): DocxRenderCapabilities {
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
