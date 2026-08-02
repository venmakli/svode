import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

test("manual Actors save request stays one-shot across surface remounts", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const { useActorMailmapSave } =
    await import("../hooks/use-actor-mailmap-save");
  const { requestActorMailmapSave, useActorMailmapSaveRequest } =
    await import("../model/mailmap-save-request");
  const calls: Array<{ args: unknown; command: string }> = [];
  useActorMailmapSaveRequest.setState({ request: null });
  mockNativeIpc((command, args) => {
    calls.push({ args, command });
    if (command === "actors_get_mailmap_save_review") {
      return {
        requiresConsent: true,
        review: {
          fingerprint: "mailmap-v2",
          repositoryId: "/repo",
        },
        status: "ready",
      };
    }
    if (command === "actors_save_mailmap") return { status: "committed" };
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  function Harness() {
    const save = useActorMailmapSave({
      projectPath: "/project",
      spacePath: "/repo",
    });
    return (
      <div>
        <span data-mailmap-review>{save.review?.fingerprint ?? ""}</span>
        <button type="button" onClick={() => void save.confirm()}>
          confirm
        </button>
      </div>
    );
  }

  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      requestActorMailmapSave({
        projectPath: "/project",
        spacePath: "/repo",
      });
      await nextTurn();
      await nextTurn();
    });

    expect(calls.map((call) => call.command)).toEqual([
      "actors_get_mailmap_save_review",
    ]);
    expect(
      dom.window.document.querySelector("[data-mailmap-review]")?.textContent,
    ).toBe("mailmap-v2");

    const saveButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("confirm"));
    await act(async () => {
      saveButton?.click();
      await nextTurn();
    });

    expect(calls.map((call) => call.command)).toEqual([
      "actors_get_mailmap_save_review",
      "actors_save_mailmap",
    ]);
    expect(
      dom.window.document.querySelector("[data-mailmap-review]")?.textContent,
    ).toBe("");
    const saveArgs = calls[1]?.args as {
      projectPath: string;
      review: { fingerprint: string };
      spacePath: string;
    };
    expect(saveArgs.projectPath).toBe("/project");
    expect(saveArgs.spacePath).toBe("/repo");
    expect(saveArgs.review.fingerprint).toBe("mailmap-v2");

    await act(async () => {
      root.render(<Harness key="remounted" />);
      await nextTurn();
      await nextTurn();
    });
    expect(calls.map((call) => call.command)).toEqual([
      "actors_get_mailmap_save_review",
      "actors_save_mailmap",
    ]);
    expect(
      dom.window.document.querySelector("[data-mailmap-review]")?.textContent,
    ).toBe("");
  } finally {
    await act(async () => root.unmount());
    useActorMailmapSaveRequest.setState({ request: null });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
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
