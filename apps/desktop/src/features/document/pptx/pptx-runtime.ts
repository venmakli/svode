import type { PptxPresentation } from "@silurus/ooxml/pptx";

import type { DocumentRuntimeSession } from "../model/session";
import type { DocumentFailureKind } from "../model/types";

export const PPTX_SLIDE_LIMIT = 2_000;
export const PPTX_LOAD_TIMEOUT_MS = 30_000;
export const PPTX_DECODED_IMAGE_BUDGET = 64 * 1024 * 1024;
export const PPTX_RESOURCE_LIMITS = {
  maxArchiveEntries: 2_048,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxTotalInflatedBytes: 96 * 1024 * 1024,
} as const;
export const PPTX_IMAGE_RESOURCES = {
  decodedByteBudget: PPTX_DECODED_IMAGE_BUDGET,
  strategy: "strict",
} as const;

type PptxRuntime = typeof import("@silurus/ooxml/pptx");
type PptxRenderMode = "main" | "worker";

export interface PptxRenderCapabilities {
  bitmapRenderer: boolean;
  offscreenCanvas: boolean;
  worker: boolean;
}

let pptxRuntimePromise: Promise<PptxRuntime> | null = null;

export class PptxRuntimeFailure extends Error {
  constructor(
    readonly kind: DocumentFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "PptxRuntimeFailure";
  }
}

export class PptxPasswordFailure extends Error {
  constructor(readonly incorrect: boolean) {
    super(
      incorrect ? "PPTX password is incorrect" : "PPTX requires a password",
    );
    this.name = "PptxPasswordFailure";
  }
}

export async function getPptxRuntime() {
  pptxRuntimePromise ??= import("@silurus/ooxml/pptx");
  return pptxRuntimePromise;
}

export async function openPptxPresentation({
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
  const runtime = await getPptxRuntime();
  if (session.signal.aborted) throw new PptxAbortError();

  onLoading(0.5);
  const source = Uint8Array.from(bytes).buffer;
  const loading = runtime.PptxPresentation.load(source, {
    mode: selectPptxRenderMode(getPptxRenderCapabilities()),
    password,
    resourceLimits: PPTX_RESOURCE_LIMITS,
    useGoogleFonts: false,
    workerTimeoutMs: PPTX_LOAD_TIMEOUT_MS,
  });

  let presentation: PptxPresentation;
  try {
    presentation = await waitForPptxLoad(loading, session);
  } catch (error) {
    throw normalizePptxRuntimeError(error);
  }

  try {
    validatePptxPresentationBounds(presentation);
  } catch (error) {
    presentation.destroy();
    throw error;
  }

  session.addDisposer(() => presentation.destroy());
  onLoading(1);
  return presentation;
}

export function validatePptxPresentationBounds(
  presentation: Pick<PptxPresentation, "slideCount">,
) {
  if (presentation.slideCount < 1) {
    throw new PptxRuntimeFailure("malformed", "PPTX does not contain a slide");
  }
  if (presentation.slideCount > PPTX_SLIDE_LIMIT) {
    throw new PptxRuntimeFailure(
      "resource_limit",
      `PPTX contains ${presentation.slideCount} slides; the preview limit is ${PPTX_SLIDE_LIMIT}`,
    );
  }
}

export function selectPptxRenderMode({
  bitmapRenderer,
  offscreenCanvas,
  worker,
}: PptxRenderCapabilities): PptxRenderMode {
  return worker && offscreenCanvas && bitmapRenderer ? "worker" : "main";
}

export function normalizePptxRuntimeError(error: unknown): Error {
  if (
    error instanceof PptxRuntimeFailure ||
    error instanceof PptxPasswordFailure ||
    error instanceof PptxAbortError
  ) {
    return error;
  }

  const code = errorCode(error);
  if (code === "encrypted" || code === "invalid-password") {
    return new PptxPasswordFailure(code === "invalid-password");
  }
  if (code === "ooxml-resource-limit" || code === "ooxml-decoded-image-limit") {
    return new PptxRuntimeFailure("resource_limit", errorMessage(error));
  }
  if (code === "unsupported-encryption" || code === "legacy-binary-format") {
    return new PptxRuntimeFailure("external_only", errorMessage(error));
  }
  if (code === "not-ooxml" || code === "parser-crashed") {
    return new PptxRuntimeFailure("malformed", errorMessage(error));
  }
  return new PptxRuntimeFailure("renderer_error", errorMessage(error));
}

export function isPptxAbortError(error: unknown) {
  return error instanceof PptxAbortError || errorCode(error) === "AbortError";
}

async function waitForPptxLoad(
  loading: Promise<PptxPresentation>,
  session: DocumentRuntimeSession,
) {
  return new Promise<PptxPresentation>((resolve, reject) => {
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
    const abort = () => fail(new PptxAbortError());
    const timeout = setTimeout(
      () =>
        fail(
          new PptxRuntimeFailure(
            "resource_limit",
            "PPTX preview exceeded the 30 second load limit",
          ),
        ),
      PPTX_LOAD_TIMEOUT_MS,
    );

    session.signal.addEventListener("abort", abort, { once: true });
    if (session.signal.aborted) abort();

    void loading.then(
      (presentation) => {
        if (settled) {
          presentation.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(presentation);
      },
      (error) => fail(error),
    );
  });
}

class PptxAbortError extends Error {
  constructor() {
    super("PPTX loading was aborted");
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

function getPptxRenderCapabilities(): PptxRenderCapabilities {
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
