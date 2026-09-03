import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Skeleton } from "@/components/ui/skeleton";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import type {
  MediaFailure,
  MediaRuntimeMetadata,
  MediaSourceDescriptor,
  MediaViewState,
} from "../model/types";
import { MediaToolbar } from "./media-toolbar";

const VIDEO_SIDE_LIMIT = 16_384;
const VIDEO_PIXEL_LIMIT = 40_000_000;

export function MediaPlaybackViewer({
  externalOpenError,
  loading,
  onOpenExternal,
  onPlaybackError,
  onReady,
  onRegisterExternalSuspender,
  onRegisterRendererDisposer,
  onViewStateChange,
  source,
  title,
  toolbarActions,
  viewState,
}: {
  externalOpenError: boolean;
  loading: boolean;
  onOpenExternal(): void;
  onPlaybackError(source: MediaSourceDescriptor, failure: MediaFailure): void;
  onReady(source: MediaSourceDescriptor, metadata: MediaRuntimeMetadata): void;
  onRegisterExternalSuspender(
    suspender: () => void | Promise<void>,
  ): () => void;
  onRegisterRendererDisposer(disposer: () => void | Promise<void>): () => void;
  onViewStateChange(
    update: MediaViewState | ((current: MediaViewState) => MediaViewState),
  ): void;
  source: MediaSourceDescriptor;
  title: string;
  toolbarActions?: ReactNode;
  viewState: MediaViewState;
}) {
  const elementRef = useRef<HTMLMediaElement | null>(null);
  const loadedTokenRef = useRef<string | null>(null);
  const metadataLoadedRef = useRef(false);
  const [buffering, setBuffering] = useState(false);

  const setElement = useCallback((element: HTMLMediaElement | null) => {
    elementRef.current = element;
  }, []);

  const snapshotPlaybackState = useCallback(() => {
    const element = elementRef.current;
    if (!element || !metadataLoadedRef.current) return;
    onViewStateChange((current) => ({
      ...current,
      playback: {
        currentTime: finiteOr(
          element.currentTime,
          current.playback.currentTime,
        ),
        muted: element.muted,
        playbackRate: finiteOr(
          element.playbackRate,
          current.playback.playbackRate,
        ),
        volume: finiteOr(element.volume, current.playback.volume),
      },
    }));
  }, [onViewStateChange]);

  useEffect(
    () =>
      onRegisterExternalSuspender(async () => {
        snapshotPlaybackState();
        const element = elementRef.current;
        if (element) await suspendPlaybackElement(element);
      }),
    [onRegisterExternalSuspender, snapshotPlaybackState],
  );

  useEffect(
    () =>
      onRegisterRendererDisposer(async () => {
        metadataLoadedRef.current = false;
        const element = elementRef.current;
        if (element) await disposePlaybackElement(element);
      }),
    [onRegisterRendererDisposer],
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element || loadedTokenRef.current === source.capabilityToken) return;
    loadedTokenRef.current = source.capabilityToken;
    if (!element.canPlayType(source.mimeType)) {
      onPlaybackError(source, { kind: "unsupported_codec" });
      return;
    }
    element.src = source.sourceUrl;
    element.load();
  }, [onPlaybackError, source]);

  const handleLoadedMetadata = () => {
    const element = elementRef.current;
    if (!element) return;
    const durationSeconds = finiteDuration(element.duration);
    if (durationSeconds === null) {
      onPlaybackError(source, { kind: "malformed" });
      return;
    }
    const dimensions =
      element instanceof HTMLVideoElement
        ? { height: element.videoHeight, width: element.videoWidth }
        : undefined;
    if (dimensions && (!dimensions.width || !dimensions.height)) {
      onPlaybackError(source, { kind: "malformed" });
      return;
    }
    if (
      dimensions &&
      !videoDimensionsWithinLimits(dimensions.width, dimensions.height)
    ) {
      onPlaybackError(source, { kind: "resource_limit" });
      return;
    }

    metadataLoadedRef.current = true;
    restorePlaybackState(element, viewState, durationSeconds);
    onReady(source, {
      durationSeconds,
      height: dimensions?.height,
      width: dimensions?.width,
    });
    snapshotPlaybackState();
  };

  const handleError = () => {
    const element = elementRef.current;
    const failure = classifyPlaybackFailure(
      element?.error?.code ?? 0,
      metadataLoadedRef.current,
      source.requiresRangeRequests,
    );
    onPlaybackError(source, failure);
  };

  const commonProps = {
    "aria-busy": loading || buffering,
    "aria-hidden": loading,
    autoPlay: false,
    controls: !loading,
    onCanPlay: () => setBuffering(false),
    onError: handleError,
    onLoadedMetadata: handleLoadedMetadata,
    onPause: snapshotPlaybackState,
    onPlay: () => {
      setBuffering(false);
      snapshotPlaybackState();
    },
    onRateChange: snapshotPlaybackState,
    onStalled: () => setBuffering(true),
    onTimeUpdate: snapshotPlaybackState,
    onVolumeChange: snapshotPlaybackState,
    onWaiting: () => setBuffering(true),
    preload: "metadata" as const,
    tabIndex: loading ? -1 : undefined,
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <MediaToolbar
        onOpenExternal={onOpenExternal}
        source={source}
        title={title}
        toolbarActions={toolbarActions}
      />
      {source.family === "audio" ? (
        <div className="relative flex min-h-0 flex-1 items-center bg-muted/30 px-4 py-6">
          <audio
            {...commonProps}
            ref={setElement}
            className={cn("w-full", loading && "opacity-0")}
            aria-label={m.media_audio_player({ filename: title })}
          />
          {loading ? (
            <Skeleton className="absolute inset-x-4 top-1/2 h-12 -translate-y-1/2 rounded-full" />
          ) : null}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-4">
          <video
            {...commonProps}
            ref={setElement}
            className={cn(
              "max-h-full max-w-full object-contain",
              loading && "opacity-0",
            )}
            aria-label={m.media_video_player({ filename: title })}
            playsInline
          />
          {loading ? (
            <Skeleton className="absolute inset-4 rounded-lg" />
          ) : null}
        </div>
      )}
      {buffering ? (
        <p className="sr-only" aria-live="polite">
          {m.media_buffering()}
        </p>
      ) : null}
      {externalOpenError ? (
        <p
          className="shrink-0 border-t px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {m.media_external_open_error()}
        </p>
      ) : null}
    </div>
  );
}

export function classifyPlaybackFailure(
  mediaErrorCode: number,
  metadataLoaded: boolean,
  requiresRangeRequests: boolean,
): MediaFailure {
  if (mediaErrorCode === 4) return { kind: "unsupported_codec" };
  if (!metadataLoaded && mediaErrorCode === 3) return { kind: "malformed" };
  if (!metadataLoaded && mediaErrorCode === 2 && requiresRangeRequests) {
    return { kind: "unusable_range" };
  }
  return { kind: "playback_error" };
}

export function videoDimensionsWithinLimits(width: number, height: number) {
  return (
    width > 0 &&
    height > 0 &&
    width <= VIDEO_SIDE_LIMIT &&
    height <= VIDEO_SIDE_LIMIT &&
    width * height <= VIDEO_PIXEL_LIMIT
  );
}

function finiteDuration(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function restorePlaybackState(
  element: HTMLMediaElement,
  viewState: MediaViewState,
  durationSeconds: number,
) {
  element.pause();
  element.muted = viewState.playback.muted;
  element.volume = Math.min(1, Math.max(0, viewState.playback.volume));
  element.playbackRate = Math.min(
    4,
    Math.max(0.25, viewState.playback.playbackRate),
  );
  if (durationSeconds > 0) {
    element.currentTime = Math.min(
      durationSeconds,
      Math.max(0, viewState.playback.currentTime),
    );
  }
}

async function suspendPlaybackElement(element: HTMLMediaElement) {
  try {
    element.pause();
  } catch {
    // Continue presentation cleanup even if the native element already ended.
  }
  if (
    typeof document !== "undefined" &&
    document.fullscreenElement === element &&
    document.exitFullscreen
  ) {
    await document.exitFullscreen().catch(() => undefined);
  }
  if (
    typeof document !== "undefined" &&
    document.pictureInPictureElement === element &&
    document.exitPictureInPicture
  ) {
    await document.exitPictureInPicture().catch(() => undefined);
  }
  const webkitVideo = element as WebkitPresentationVideo;
  if (
    webkitVideo.webkitPresentationMode &&
    webkitVideo.webkitPresentationMode !== "inline" &&
    webkitVideo.webkitSetPresentationMode
  ) {
    try {
      webkitVideo.webkitSetPresentationMode("inline");
    } catch {
      // The element may already have left its presentation mode.
    }
  }
}

async function disposePlaybackElement(element: HTMLMediaElement) {
  await suspendPlaybackElement(element);
  element.removeAttribute("src");
  try {
    element.load();
  } catch {
    // Revoking the backend capability must still continue.
  }
}

type WebkitPresentationVideo = HTMLMediaElement & {
  webkitPresentationMode?: "fullscreen" | "inline" | "picture-in-picture";
  webkitSetPresentationMode?(mode: "inline"): void;
};
