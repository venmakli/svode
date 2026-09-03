import {
  inspectDocumentSource,
  listenDocumentSourceInvalidated,
  openDocumentExternal,
  readDocumentSource,
} from "@/platform/document/document-api";

import type {
  DocumentFailure,
  DocumentSourceDescriptor,
  DocumentTarget,
} from "../model/types";
import { normalizeRuntimePath } from "../model/types";

export async function loadDocumentDescriptor(
  target: DocumentTarget,
): Promise<DocumentSourceDescriptor> {
  try {
    return await inspectDocumentSource(toSourceInput(target));
  } catch (error) {
    throw documentFailureFromNative(error);
  }
}

export async function loadDocumentBytes(
  target: DocumentTarget,
  expectedGeneration: string,
): Promise<Uint8Array> {
  try {
    return await readDocumentSource({
      ...toSourceInput(target),
      expectedGeneration,
    });
  } catch (error) {
    throw documentFailureFromNative(error);
  }
}

export async function openDocumentInSystem(target: DocumentTarget) {
  try {
    await openDocumentExternal(toSourceInput(target));
  } catch (error) {
    throw documentFailureFromNative(error);
  }
}

export function subscribeDocumentInvalidated(
  target: DocumentTarget,
  handler: () => void,
) {
  return listenDocumentSourceInvalidated((event) => {
    if (
      normalizeRuntimePath(event.spacePath) !==
      normalizeRuntimePath(target.spacePath)
    ) {
      return;
    }
    if (
      event.changes.some(
        (change) =>
          change.kind === "binary" &&
          normalizeRelativePath(change.path) ===
            normalizeRelativePath(target.path),
      )
    ) {
      handler();
    }
  });
}

export function documentFailureFromNative(error: unknown): DocumentFailure {
  if (isNativeDocumentError(error)) {
    switch (error.kind) {
      case "resource_limit":
        return {
          actualBytes: error.actualBytes,
          detail: error.message,
          kind: "resource_limit",
          limitBytes: error.limitBytes,
        };
      case "source_changed":
        return { kind: "source_changed" };
      case "source_missing":
        return { kind: "source_missing" };
      case "external_open_failed":
        return { detail: error.message, kind: "renderer_error" };
      case "source_inaccessible":
      case "unsupported_format":
        return { detail: error.message, kind: "external_only" };
    }
  }
  return {
    detail: error instanceof Error ? error.message : String(error),
    kind: "renderer_error",
  };
}

function toSourceInput(target: DocumentTarget) {
  return {
    projectPath: target.projectPath,
    spaceId: target.spaceId,
    targetPath: target.path,
  };
}

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isNativeDocumentError(value: unknown): value is {
  kind:
    | "source_missing"
    | "source_inaccessible"
    | "unsupported_format"
    | "resource_limit"
    | "source_changed"
    | "external_open_failed";
  message: string;
  limitBytes?: number;
  actualBytes?: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
