import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import {
  DEFAULT_MEDIA_VIEW_STATE,
  type MediaSourceDescriptor,
} from "../model/types";
import {
  classifyPlaybackFailure,
  MediaPlaybackViewer,
  videoDimensionsWithinLimits,
} from "./media-playback-viewer";
import { formatMediaDuration } from "./media-toolbar";

const audioSource: MediaSourceDescriptor = {
  animated: false,
  capabilityToken: "opaque",
  family: "audio" as const,
  format: "mp3" as const,
  generation: "generation",
  height: null,
  inlinePreview: false,
  intrinsicOversized: false,
  mimeType: "audio/mpeg",
  requiresRangeRequests: false,
  sizeBytes: 1024,
  sourceUrl: "svode-media://localhost/opaque",
  width: null,
};

test("audio and video use one native control set without autoplay", () => {
  const audio = renderPlayback(audioSource);
  expect(audio.includes("<audio")).toBe(true);
  expect(audio.includes("<video")).toBe(false);
  expect(audio.includes('controls=""')).toBe(true);
  expect(audio.includes('preload="metadata"')).toBe(true);
  expect(audio.includes("autoplay")).toBe(false);
  expect(audio.includes("flex min-h-0 flex-1 items-center")).toBe(true);

  const video = renderPlayback({
    ...audioSource,
    family: "video" as const,
    format: "mp4" as const,
    mimeType: "video/mp4",
  });
  expect(video.includes("<video")).toBe(true);
  expect(video.toLowerCase().includes('playsinline=""')).toBe(true);
  expect(video.includes("autoplay")).toBe(false);
  expect(video.includes("flex min-h-0 flex-1 items-center")).toBe(true);
});

test("runtime playback failures remain typed", () => {
  expect(classifyPlaybackFailure(4, false, false).kind).toBe(
    "unsupported_codec",
  );
  expect(classifyPlaybackFailure(3, false, false).kind).toBe("malformed");
  expect(classifyPlaybackFailure(2, false, true).kind).toBe("unusable_range");
  expect(classifyPlaybackFailure(3, true, false).kind).toBe("playback_error");
});

test("video frame and duration metadata stay bounded and deterministic", () => {
  expect(videoDimensionsWithinLimits(1920, 1080)).toBe(true);
  expect(videoDimensionsWithinLimits(20_000, 1080)).toBe(false);
  expect(videoDimensionsWithinLimits(10_000, 10_000)).toBe(false);
  expect(formatMediaDuration(65)).toBe("1:05");
  expect(formatMediaDuration(3661)).toBe("1:01:01");
});

function renderPlayback(source: MediaSourceDescriptor) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MediaPlaybackViewer
        externalOpenError={false}
        loading={false}
        onOpenExternal={() => undefined}
        onPlaybackError={() => undefined}
        onReady={() => undefined}
        onRegisterExternalSuspender={() => () => undefined}
        onRegisterRendererDisposer={() => () => undefined}
        onViewStateChange={() => undefined}
        source={source}
        title="fixture.mp3"
        viewState={DEFAULT_MEDIA_VIEW_STATE}
      />
    </TooltipProvider>,
  );
}
