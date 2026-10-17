import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

// The editor mock must not reach other test files of the same process.
const isolated = process.env.SVODE_README_SURFACE_DOM === "1";
if (!isolated) {
  test("README surface DOM scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_README_SURFACE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 30000);
}
const domTest: typeof test = isolated ? test : () => undefined;

domTest(
  "an explicit save failure stays silent while the save block indicator shows",
  async () => {
    let editorProps: { saveFailureShown?: () => boolean } = {};
    mock.module("@/features/editor", () => ({
      PlateDocumentEditor: (props: typeof editorProps) => {
        editorProps = props;
        return null;
      },
    }));
    const dom = new JSDOM(
      "<!doctype html><html><body><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost/" },
    );
    const restore = installDomGlobals(dom);
    const spacePath = `/readme-surface-${Math.random()}`;
    mockNativeIpc(
      async (command) => {
        if (command === "repository_access_get")
          return {
            checkedAt: null,
            expiresAt: null,
            generation: 1,
            lastKnownStatus: null,
            reason: null,
            repositoryId: spacePath,
            status: "local",
          };
        if (command === "read_page")
          return {
            path: "page.md",
            body: "",
            meta: {
              title: "Page",
              icon: null,
              created: "",
              updated: "",
              extra: {},
            },
          };
        return null;
      },
      { shouldMockEvents: true },
    );
    const { PageDetailProvider } = await import("../hooks/page-detail-context");
    const { PageSurfaceSessionProvider, usePageSurfaceSession } =
      await import("../hooks/page-surface-context");
    const { ReadmeSurface } = await import("./readme-surface");
    let session!: ReturnType<typeof usePageSurfaceSession>;
    function Probe() {
      const current = usePageSurfaceSession();
      useEffect(() => {
        session = current;
      });
      return <ReadmeSurface />;
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <PageSurfaceSessionProvider
            displayName="Page"
            displayPath="page.md"
            spacePath={spacePath}
            targetKey={spacePath}
          >
            <PageDetailProvider
              spacePath={spacePath}
              spaceId="root"
              readmePath="page.md"
              ownerPath="."
              target="page"
              onOpenPath={() => undefined}
            >
              <Probe />
            </PageDetailProvider>
          </PageSurfaceSessionProvider>,
        );
        for (let step = 0; step < 5; step += 1) await nextTurn();
      });
      expect(editorProps.saveFailureShown?.()).toBe(false);

      const conflict = {
        status: "ready" as const,
        pending: null,
        failure: null,
        writeDraft: () => undefined,
        loadFile: () => undefined,
        retryRead: () => undefined,
      };
      await act(async () => session.reportSourceConflict(conflict));
      expect(editorProps.saveFailureShown?.()).toBe(true);

      await act(async () => session.reportSourceConflict(null));
      expect(editorProps.saveFailureShown?.()).toBe(false);
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  },
);

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
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
