import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

const isolatedProcess = process.env.SVODE_REPOSITORY_WORK_STATUS_DOM === "1";

if (!isolatedProcess) {
  test("repository work status DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_REPOSITORY_WORK_STATUS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  test("repository work status keeps one compact exact-target recovery control", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const calls: Array<{ command: string; spacePath: string }> = [];
    let rootStatus: AccessStatus = "local";
    let childStatus: AccessStatus = "unknown";
    let generation = 0;
    mockNativeIpc(
      (command, args) => {
        const spacePath = String(
          (args as { spacePath?: string } | undefined)?.spacePath ?? "",
        );
        calls.push({ command, spacePath });
        generation += 1;
        if (command === "repository_access_get") {
          const status = spacePath === "/child" ? childStatus : rootStatus;
          return snapshot(spacePath, status, generation);
        }
        if (command === "repository_access_verify") {
          if (spacePath === "/child") childStatus = "writable";
          else rootStatus = "writable";
          return snapshot(spacePath, "writable", generation);
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { RepositoryWorkStatus } = await import("./repository-work-status");
    const settingsPaths: string[] = [];
    const root = createRoot(dom.window.document.getElementById("app")!);

    try {
      await act(async () => {
        root.render(
          <RepositoryWorkStatus
            contextName="Project"
            displayPath="/project"
            repositoryPath="/project"
            onOpenRepositorySettings={(path) => settingsPaths.push(path)}
          />,
        );
        await nextFrame(dom);
        await nextFrame(dom);
      });

      const rootTrigger = workStatusTrigger(dom);
      expect(rootTrigger.dataset.repositoryWorkStatusState).toBe("local");
      expect(rootTrigger.getAttribute("aria-label")?.includes("Project")).toBe(
        true,
      );
      expect(rootTrigger.textContent.includes("Editing available")).toBe(true);
      expect(
        calls.some(({ command }) => command === "repository_access_verify"),
      ).toBe(false);

      await act(async () => {
        rootTrigger.focus();
        rootTrigger.click();
        await nextFrame(dom);
      });
      const rootPopover = popover(dom)!;
      expect(rootPopover.textContent.includes("Editing is available")).toBe(
        true,
      );
      expect(rootPopover.textContent.includes("/project")).toBe(true);
      const settingsButton = Array.from(
        rootPopover.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes("Open Git settings"))!;
      await act(async () => settingsButton.click());
      expect(settingsPaths).toEqual(["/project"]);
      await act(async () => {
        rootPopover.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });

      await act(async () => {
        root.render(
          <RepositoryWorkStatus
            contextName="Independent Space"
            displayPath="child"
            repositoryPath="/child"
            onOpenRepositorySettings={(path) => settingsPaths.push(path)}
          />,
        );
        await nextFrame(dom);
        await nextFrame(dom);
      });

      const childTrigger = workStatusTrigger(dom);
      expect(childTrigger.dataset.repositoryWorkStatusState).toBe("unknown");
      expect(childTrigger.textContent.includes("View only")).toBe(true);
      expect(
        childTrigger.getAttribute("aria-label")?.includes("Independent Space"),
      ).toBe(true);
      await act(async () => {
        childTrigger.click();
        await nextFrame(dom);
      });
      const childPopover = popover(dom);
      expect(Boolean(childPopover)).toBe(true);
      const verifyButton = Array.from(
        childPopover!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes("Check access"))!;
      await act(async () => {
        verifyButton.click();
        await nextFrame(dom);
        await nextFrame(dom);
      });

      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
        "writable",
      );
      expect(
        calls.some(
          ({ command, spacePath }) =>
            command === "repository_access_verify" && spacePath === "/child",
        ),
      ).toBe(true);
      await act(async () => {
        popover(dom)?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });
}

type AccessStatus = "local" | "writable" | "unknown";

function snapshot(path: string, status: AccessStatus, generation: number) {
  return {
    checkedAt: null,
    expiresAt: null,
    generation,
    lastKnownStatus: null,
    reason: status === "unknown" ? "not_checked" : null,
    repositoryId: `repo:${path}`,
    status,
  };
}

function workStatusTrigger(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLButtonElement>(
    "[data-repository-work-status]",
  )!;
}

function popover(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLElement>(
    '[data-slot="popover-content"]',
  );
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextFrame(dom: JSDOM) {
  return new Promise<void>((resolve) => {
    dom.window.setTimeout(
      () => dom.window.requestAnimationFrame(() => resolve()),
      0,
    );
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
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
