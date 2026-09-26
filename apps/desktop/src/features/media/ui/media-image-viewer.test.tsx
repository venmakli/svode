import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { MediaImageViewer, maxSafeZoom } from "./media-image-viewer";
import { formatMediaBytes } from "./media-toolbar";
import type { ExternalOpenBinding } from "@/features/external-open";

const externalOpen: ExternalOpenBinding = {
  target: {
    preferenceKey: "file:fixture",
    listApps: () => Promise.resolve([]),
    open: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
  },
  onError: () => undefined,
};

const svgSource = {
  animated: false,
  capabilityToken: "opaque",
  family: "image" as const,
  format: "svg" as const,
  generation: "generation",
  height: 600,
  inlinePreview: true,
  intrinsicOversized: false,
  mimeType: "image/svg+xml",
  requiresRangeRequests: false,
  sizeBytes: 1024,
  sourceUrl: "svode-media://localhost/opaque",
  width: 800,
};

test("SVG is composed only as an image resource", () => {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <MediaImageViewer
        externalOpenError={false}
        loading={false}
        externalOpen={externalOpen}
        onReady={() => undefined}
        onRegisterExternalSuspender={() => () => undefined}
        onRegisterRendererDisposer={() => () => undefined}
        onRenderError={() => undefined}
        onViewStateChange={() => undefined}
        source={svgSource}
        title="malicious.svg"
        viewState={{
          mode: "fit",
          panX: 0,
          panY: 0,
          playback: {
            currentTime: 0,
            muted: false,
            playbackRate: 1,
            volume: 1,
          },
          zoom: 1,
        }}
      />
    </TooltipProvider>,
  );
  expect(markup.includes("<img")).toBe(true);
  expect(markup.includes("data-external-open-primary")).toBe(true);
  expect(markup.includes('aria-label="Open with"')).toBe(true);
  expect(markup.includes("<iframe")).toBe(false);
  expect(markup.includes("<object")).toBe(false);
  expect(markup.includes("<embed")).toBe(false);
  expect(markup.includes("<script")).toBe(false);
});

test("metadata formatting and SVG actual-size bound stay deterministic", () => {
  expect(formatMediaBytes(1024)).toBe("1 KB");
  expect(
    maxSafeZoom({
      ...svgSource,
      height: 20_000,
      intrinsicOversized: true,
      width: 20_000,
    }) < 1,
  ).toBe(true);
});
