import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useRepositoryAccess,
  type RepositoryAccessSnapshot,
} from "@/features/git";
import { createRegisteredSpaceOwner } from "@/features/scope-surfaces";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { ActorsSurface } from "./actors-surface";
import { RepositoryAccessHeader } from "./repository-access-header";

const UNKNOWN_ACCESS: RepositoryAccessSnapshot = {
  checkedAt: null,
  expiresAt: null,
  generation: 1,
  lastKnownStatus: null,
  reason: "not_checked",
  repositoryId: "access-repo-test",
  status: "unknown",
};

test("repository access reads locally on mount and probes only after explicit action", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  let finishVerify: ((value: RepositoryAccessSnapshot) => void) | undefined;
  mockNativeIpc((command) => {
    calls.push(command);
    if (command === "repository_access_get") return UNKNOWN_ACCESS;
    if (command === "repository_access_verify") {
      return new Promise<RepositoryAccessSnapshot>((resolve) => {
        finishVerify = resolve;
      });
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<AccessHarness spacePath="/repo" />);
      await nextTurn();
    });

    expect(calls).toEqual(["repository_access_get"]);
    const button = dom.window.document.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(calls).toEqual([
      "repository_access_get",
      "repository_access_verify",
    ]);
    expect(button.disabled).toBe(true);
    expect(
      dom.window.document
        .querySelector("[data-repository-access-header]")
        ?.getAttribute("data-repository-access-status"),
    ).toBe("checking");

    await act(async () => {
      finishVerify?.({
        ...UNKNOWN_ACCESS,
        checkedAt: 1_700_000_000,
        expiresAt: 1_700_086_400,
        generation: 3,
        reason: null,
        status: "writable",
      });
      await nextTurn();
    });
    expect(button.disabled).toBe(false);
    expect(dom.window.document.body.textContent?.includes("Editing")).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("access load failure stays isolated from the actors catalog", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  mockNativeIpc((command) => {
    if (command === "repository_access_get") {
      throw new Error("access store unavailable");
    }
    if (command === "actors_get_catalog") {
      return {
        diagnostics: [],
        generation: 1,
        repositoryId: "actor-repo-test",
        rows: [
          {
            aliases: [],
            canonicalEmail: "ada@example.test",
            commitCount: 4,
            contribution: "contributor",
            displayName: "Ada Lovelace",
            lastActivityDate: "2026-07-31",
            lastCommitAt: 20,
            sources: [],
          },
        ],
        shallow: false,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);
  const owner = createRegisteredSpaceOwner({
    hasSchema: false,
    projectPath: "/project",
    spaceId: "root",
    spacePath: "/repo",
    status: "ready",
  });

  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorsSurface owner={owner} presentation="full" />
        </TooltipProvider>,
      );
      await nextTurn();
    });

    expect(
      dom.window.document.body.textContent?.includes(
        "Repository access could not be loaded.",
      ),
    ).toBe(true);
    expect(dom.window.document.body.textContent?.includes("Ada Lovelace")).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function AccessHarness({ spacePath }: { spacePath: string }) {
  const access = useRepositoryAccess(spacePath);
  return (
    <RepositoryAccessHeader
      error={access.error}
      snapshot={access.snapshot}
      verifying={access.verifying}
      onVerify={() => void access.verify()}
    />
  );
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
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
