import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  AttachmentActivationRequest,
  AttachmentOwnerRef,
} from "@/features/attachments";
import type { ScopeSurfacePage } from "./scope-surface-page";

if (process.env.SVODE_ATTACHMENT_OWNER_PEEK_TEST !== "1") {
  test("Collection/App attachments stay in guarded Peek until Full page", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ATTACHMENT_OWNER_PEEK_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  mock.module("@/features/page/scope-surface", () => ({
    PageDetailProvider: ({ children }: { children: ReactNode }) => children,
    PageSurfaceSessionProvider: ({ children }: { children: ReactNode }) =>
      children,
    usePageDetailContext: () => null,
    useOptionalPageDetailContext: () => null,
    ReadmeSurface: () => null,
    PageAccessRecovery: () => null,
    usePageSurfaceSession: () => ({
      runMutation: async (operation: () => Promise<void>) => operation(),
    }),
  }));
  let canClose = false;
  let guardCalls = 0;
  mock.module("./scope-surface-page", () => ({
    ScopeSurfacePage: function Scope(
      props: ComponentProps<typeof ScopeSurfacePage>,
    ) {
      const { registerNavigationGuard } = props;
      useEffect(
        () =>
          registerNavigationGuard?.(async () => {
            guardCalls += 1;
            return canClose;
          }),
        [registerNavigationGuard],
      );
      return (
        <div
          data-owner={props.owner.identityKind}
          data-surface={props.compactSurfaceState?.surfaceId}
          data-readme={props.owner.readmePath}
          data-app={props.owner.capabilities.includes("app")}
        >
          <button
            onClick={() => {
              props.compactSurfaceState?.onSurfaceIdChange("collection");
              props.routeState?.onViewNameChange("Board");
            }}
          >
            Collection view
          </button>
        </div>
      );
    },
  }));
  test("actual Sheet keeps owner selection, guards close/full-page, and preserves tab/view", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><button id='row'>Row</button><div id='app'></div></body></html>",
      { url: "http://localhost/", pretendToBeVisual: true },
    );
    const restore = installDomGlobals(dom);
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { AttachmentsSurface } = await import("@/features/attachments");
    const { mockNativeIpc, clearNativeMocks } =
      await import("@/platform/native/testing");
    let snapshotTarget: AttachmentActivationRequest;
    let directoryChild = false;
    mockNativeIpc((command, args) =>
      command === "attachments_list"
        ? {
            owner: snapshotTarget.owner,
            generation: snapshotTarget.sourceGeneration,
            items:
              args && "branchPath" in args
                ? directoryChild
                  ? [
                      {
                        ...snapshotTarget.row,
                        key: "app:child/tool",
                        path: "child/tool",
                        ownerPath: "child/tool",
                        kind: "app",
                        hasApp: true,
                        displayName: "Tool",
                      },
                    ]
                  : []
                : [snapshotTarget.row],
            diagnostics: [],
          }
        : 1,
    );
    const { AttachmentOwnerPeek } = await import("./attachment-owner-peek");
    const { useCollectionRouteState } =
      await import("./hooks/use-collection-route-state");
    const { getActiveContentSelection, openScopeOwner, closeActiveContent } =
      await import("@/features/artifact");
    const owner: AttachmentOwnerRef = {
      ownerKey: "space:root",
      identityKind: "registered-space",
      projectPath: "/repo",
      spacePath: "/repo",
      spaceId: "root",
      ownerPath: ".",
      contentPath: "README.md",
      hasDirectCollection: false,
    };
    let observedView: string | null = null;
    function Harness() {
      const route = useCollectionRouteState();
      useEffect(() => {
        observedView = route.viewName;
      }, [route.viewName]);
      return (
        <TooltipProvider>
          <AttachmentsSurface
            owner={owner}
            readOnly={false}
            renderOwnerPeek={(context) => <AttachmentOwnerPeek {...context} />}
          />
        </TooltipProvider>
      );
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    try {
      for (const kind of ["collection", "app", "directory"] as const) {
        canClose = false;
        const row = {
          key: kind + ":child",
          path: kind === "collection" ? "child/readme.md" : "child",
          contentPath: kind === "collection" ? "child/readme.md" : null,
          ownerPath: "child",
          sourcePath: "child/schema.yaml",
          sourceShape: "directory" as const,
          kind,
          hasApp: kind !== "directory",
          icon: null,
          displayName: "Child",
          modified: "",
          sizeBytes: null,
          format: "",
          availability: "available" as const,
        };
        const target: AttachmentActivationRequest = {
          row,
          mode: "peek",
          owner: {
            projectPath: "/repo",
            spacePath: "/repo",
            spaceId: null,
            ownerPath: ".",
            repositoryPath: "/repo",
          },
          sourceGeneration: "one",
          activation: {
            rowId: row.key,
            returnFocus: () => dom.window.document.getElementById("row"),
          },
        };
        openScopeOwner({ kind: "space", spaceId: "root" });
        const before = getActiveContentSelection().selection;
        snapshotTarget = target;
        await act(async () => root.render(<Harness key={kind} />));
        await act(async () => {
          (
            dom.window.document.querySelector(
              "[data-collection-primary]",
            ) as HTMLElement
          ).click();
        });
        const dialog = dom.window.document.querySelector('[role="dialog"]')!;
        expect(Boolean(dialog)).toBe(true);
        expect(getActiveContentSelection().selection).toEqual(before);
        if (kind === "directory") {
          expect(dialog.textContent?.includes("No available items")).toBe(true);
          expect(dialog.querySelector("[data-owner]")).toBeNull();
          expect(
            [...dialog.querySelectorAll("button")].some((button) =>
              button.textContent?.includes("Expand"),
            ),
          ).toBe(false);
          const close = [...dialog.querySelectorAll("button")].find((button) =>
            button.textContent?.includes("Cancel"),
          )!;
          await act(async () => close.click());
          expect(getActiveContentSelection().selection).toEqual(before);
          expect(
            dom.window.document.querySelector('[role="dialog"]'),
          ).toBeNull();
          directoryChild = true;
          const origin = dom.window.document.querySelector<HTMLElement>(
            '[data-collection-row="directory:child"]',
          )!;
          await act(async () =>
            origin
              .querySelector<HTMLElement>("[data-collection-primary]")!
              .click(),
          );
          await act(async () =>
            dom.window.document
              .querySelector<HTMLElement>(
                '[role="dialog"] [data-collection-primary]',
              )!
              .click(),
          );
          expect(
            dom.window.document
              .querySelector('[role="dialog"] [data-owner]')
              ?.getAttribute("data-surface"),
          ).toBe("app");
          canClose = true;
          const nestedClose = [
            ...dom.window.document.querySelectorAll<HTMLElement>(
              '[role="dialog"] button',
            ),
          ].find((button) => button.textContent?.includes("Cancel"))!;
          await act(async () => nestedClose.click());
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
          expect(dom.window.document.activeElement?.getAttribute("data-collection-row")).toBe("directory:child");
          expect(getActiveContentSelection().selection).toEqual(before);
          continue;
        }
        expect(
          dialog.querySelector("[data-owner]")?.getAttribute("data-surface"),
        ).toBe(kind === "app" ? "app" : "readme");
        expect(
          dialog.querySelector("[data-owner]")?.getAttribute("data-readme"),
        ).toBe(kind === "app" ? "child/README.md" : "child/readme.md");
        if (kind === "collection")
          await act(async () => {
            (
              dialog.querySelector("[data-owner] button") as HTMLElement
            ).click();
          });
        const fullPage = [...dialog.querySelectorAll("button")].find(
          (button) =>
            button.textContent?.includes("Expand") ||
            button.textContent?.includes("Развернуть"),
        )!;
        expect(Boolean(fullPage)).toBe(true);
        await act(async () => fullPage.click());
        expect(getActiveContentSelection().selection).toEqual(before);
        expect(
          Boolean(dom.window.document.querySelector('[role="dialog"]')),
        ).toBe(true);
        canClose = true;
        await act(async () => fullPage.click());
        const selection = getActiveContentSelection().selection;
        expect(selection?.kind).toBe("scope-owner");
        if (selection?.kind === "scope-owner") {
          expect(selection.request.owner).toEqual({
            kind: kind === "collection" ? "collection" : "app-directory",
            path: "child",
            spaceId: "root",
          });
          expect(selection.request.intent).toEqual({
            kind: "target",
            surfaceId: kind === "collection" ? "collection" : "app",
          });
        }
        if (kind === "collection") expect(observedView).toEqual("Board");
      }
      expect(guardCalls >= 4).toBe(true);
    } finally {
      await act(async () => root.unmount());
      closeActiveContent();
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  }, 30_000);
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
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
