import {
  filePreferenceKey,
  type ExternalOpenTarget,
} from "@/features/external-open";
import {
  createMediaSource,
  listMediaExternalApps,
  listenMediaSourceInvalidated,
  openMediaExternal,
  revealMediaExternal,
  revokeMediaSource,
  validateMediaSource,
  withMediaSourceUrl,
} from "@/platform/media/media-api";

import type {
  MediaFailure,
  MediaSourceDescriptor,
  MediaTarget,
  SpaceMediaTarget,
} from "../model/types";
import { normalizeRuntimePath } from "../model/types";

export async function loadMediaSource(
  target: MediaTarget,
): Promise<MediaSourceDescriptor> {
  try {
    return target.kind === "local"
      ? withMediaSourceUrl(await target.createSource())
      : await createMediaSource(toSourceInput(target));
  } catch (error) {
    throw mediaFailureFromNative(error);
  }
}

export async function checkMediaSource(
  target: MediaTarget,
  expectedGeneration: string,
) {
  // A local file has no Space to validate it in: its failure stays as seen.
  if (target.kind === "local") return;
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

/**
 * External open of the Media file. `beforeOpen` runs before every launch in an
 * application (playback pauses there); `onAttempt` before every action.
 */
export function mediaExternalOpenTarget(
  target: MediaTarget,
  { beforeOpen, onAttempt }: { beforeOpen(): Promise<void>; onAttempt(): void },
): ExternalOpenTarget {
  if (target.kind === "local") {
    const { externalOpen } = target;
    return {
      ...externalOpen,
      open: async (appId) => {
        onAttempt();
        await beforeOpen();
        await externalOpen.open(appId);
      },
      ...(externalOpen.reveal
        ? {
            reveal: async () => {
              onAttempt();
              await externalOpen.reveal?.();
            },
          }
        : {}),
    };
  }
  const input = toSourceInput(target);
  return {
    preferenceKey: filePreferenceKey(target.path),
    listApps: () => listMediaExternalApps(input),
    open: async (appId) => {
      onAttempt();
      await beforeOpen();
      await openMediaExternal(input, appId);
    },
    reveal: () => {
      onAttempt();
      return revealMediaExternal(input);
    },
  };
}

export function subscribeMediaInvalidated(
  target: MediaTarget,
  handler: () => void,
): Promise<() => void> {
  // Space events do not name files outside the Space.
  if (target.kind === "local") return Promise.resolve(() => undefined);
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

function toSourceInput(target: SpaceMediaTarget) {
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
