import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const isolatedDomProcess = process.env.SVODE_MEDIA_PLAYBACK_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("Media playback DOM lifecycle", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_MEDIA_PLAYBACK_DOM_PROCESS: "1",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  test("metadata load restores paused state and cleanup releases the element", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="app"></div></body></html>',
      { pretendToBeVisual: true, url: "http://localhost/" },
    );
    let loadCount = 0;
    let pauseCount = 0;
    Object.defineProperties(dom.window.HTMLMediaElement.prototype, {
      canPlayType: {
        configurable: true,
        value: () => "maybe",
      },
      load: {
        configurable: true,
        value: () => {
          loadCount += 1;
        },
      },
      pause: {
        configurable: true,
        value: () => {
          pauseCount += 1;
        },
      },
    });
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { DEFAULT_MEDIA_VIEW_STATE } = await import("../model/types");
    const { MediaPlaybackViewer } = await import("./media-playback-viewer");
    const registrations: {
      disposer?: () => void | Promise<void>;
      suspender?: () => void | Promise<void>;
    } = {};
    let readyMetadata: { durationSeconds?: number } | null = null;
    let viewState = {
      ...DEFAULT_MEDIA_VIEW_STATE,
      playback: {
        currentTime: 42,
        muted: true,
        playbackRate: 1.25,
        volume: 0.4,
      },
    };

    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <MediaPlaybackViewer
              externalOpenError={false}
              loading
              onOpenExternal={() => undefined}
              onPlaybackError={() => undefined}
              onReady={(_source, metadata) => {
                readyMetadata = metadata;
              }}
              onRegisterExternalSuspender={(next) => {
                registrations.suspender = next;
                return () => {
                  delete registrations.suspender;
                };
              }}
              onRegisterRendererDisposer={(next) => {
                registrations.disposer = next;
                return () => {
                  delete registrations.disposer;
                };
              }}
              onViewStateChange={(update) => {
                viewState =
                  typeof update === "function" ? update(viewState) : update;
              }}
              source={{
                animated: false,
                capabilityToken: "opaque",
                family: "audio",
                format: "mp3",
                generation: "generation",
                height: null,
                inlinePreview: false,
                intrinsicOversized: false,
                mimeType: "audio/mpeg",
                requiresRangeRequests: false,
                sizeBytes: 1024,
                sourceUrl: "svode-media://localhost/opaque",
                width: null,
              }}
              title="fixture.mp3"
              viewState={viewState}
            />
          </TooltipProvider>,
        );
        await nextTurn();
      });

      const audio = dom.window.document.querySelector("audio")!;
      expect(audio.controls).toBe(false);
      expect(audio.tabIndex).toBe(-1);
      expect(audio.getAttribute("aria-hidden")).toBe("true");
      Object.defineProperty(audio, "duration", {
        configurable: true,
        value: 120,
      });
      await act(async () => {
        audio.dispatchEvent(
          new dom.window.Event("loadedmetadata", { bubbles: true }),
        );
        await nextTurn();
      });
      expect(readyMetadata).toEqual({
        durationSeconds: 120,
        height: undefined,
        width: undefined,
      });
      expect(audio.paused).toBe(true);
      expect(audio.currentTime).toBe(42);
      expect(audio.muted).toBe(true);
      expect(audio.volume).toBe(0.4);
      expect(audio.playbackRate).toBe(1.25);
      expect(audio.getAttribute("src")).toBe("svode-media://localhost/opaque");

      audio.currentTime = 73;
      audio.volume = 0.6;
      await act(async () => {
        audio.dispatchEvent(
          new dom.window.Event("timeupdate", { bubbles: true }),
        );
        audio.dispatchEvent(
          new dom.window.Event("volumechange", { bubbles: true }),
        );
      });
      expect(viewState.playback.currentTime).toBe(73);
      expect(viewState.playback.volume).toBe(0.6);

      await registrations.suspender?.();
      expect(pauseCount >= 2).toBe(true);
      await registrations.disposer?.();
      expect(audio.getAttribute("src")).toBeNull();
      expect(loadCount >= 2).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
        await nextTurn();
      });
      restoreGlobals();
      dom.window.close();
    }
  });
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => undefined,
      matches: false,
      removeEventListener: () => undefined,
    }),
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLMediaElement: dom.window.HTMLMediaElement,
    HTMLVideoElement: dom.window.HTMLVideoElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
