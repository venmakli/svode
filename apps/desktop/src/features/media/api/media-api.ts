import {
  createMediaSource,
  listenMediaSourceInvalidated,
  openMediaExternal,
  revokeMediaSource,
  validateMediaSource,
} from "@/platform/media/media-api";

import type {
  MediaFailure,
  MediaSourceDescriptor,
  MediaTarget,
} from "../model/types";
import { normalizeRuntimePath } from "../model/types";

export async function loadMediaSource(
  target: MediaTarget,
): Promise<MediaSourceDescriptor> {
  try {
    return await createMediaSource(toSourceInput(target));
  } catch (error) {
    throw mediaFailureFromNative(error);
  }
}

export async function checkMediaSource(
  target: MediaTarget,
  expectedGeneration: string,
) {
  try {
    await validateMediaSource({
      ...toSourceInput(target),
      expectedGeneration,
    });
  } catch (error) {
    throw mediaFailureFromNative(error);
  }
}

export async function releaseMediaSource(capabilityToken: string) {
  await revokeMediaSource(capabilityToken).catch(() => undefined);
}

export async function openMediaInSystem(target: MediaTarget) {
  try {
    await openMediaExternal(toSourceInput(target));
  } catch (error) {
    throw mediaFailureFromNative(error);
  }
}

export function subscribeMediaInvalidated(
  target: MediaTarget,
  handler: () => void,
) {
  return listenMediaSourceInvalidated((event) => {
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

export function mediaFailureFromNative(error: unknown): MediaFailure {
  if (isNativeMediaError(error)) {
    switch (error.kind) {
      case "resource_limit":
        return {
          actualBytes: error.actualBytes,
          detail: error.message,
          kind: "resource_limit",
          limitBytes: error.limitBytes,
        };
      case "malformed":
        return { detail: error.message, kind: "malformed" };
      case "source_changed":
        return { kind: "source_changed" };
      case "source_missing":
        return { kind: "source_missing" };
      case "source_unavailable":
        return { detail: error.message, kind: "source_unavailable" };
      case "unsupported_format":
        return { detail: error.message, kind: "external_only" };
      case "external_open_failed":
        return { detail: error.message, kind: "runtime_error" };
    }
  }
  return {
    detail: error instanceof Error ? error.message : String(error),
    kind: "runtime_error",
  };
}

function toSourceInput(target: MediaTarget) {
  return {
    projectPath: target.projectPath,
    spaceId: target.spaceId,
    targetPath: target.path,
  };
}

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isNativeMediaError(value: unknown): value is {
  kind:
    | "source_missing"
    | "source_unavailable"
    | "unsupported_format"
    | "resource_limit"
    | "malformed"
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
