import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  CollectionCreateFlowFocusRequest,
  CollectionCreateFlowProps,
} from "./create-flow";

type CreateFlowComponent = typeof import("./create-flow").CollectionCreateFlow;

const isolatedDomProcess =
  process.env.SVODE_COLLECTION_CREATE_FLOW_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("Collection create-flow DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_COLLECTION_CREATE_FLOW_DOM_PROCESS: "1",
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
  test("create flow owns progress, focus, scroll, discard, and return focus", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const { CollectionCreateFlow } = await import("./create-flow");

    try {
      await act(async () => {
        root.render(<Harness Flow={CollectionCreateFlow} />);
        await nextTurn();
      });
      const trigger = findButton(dom, "Open flow");
      trigger.focus();
      await clickButton(dom, "Open flow");

      const control = dom.window.document.querySelector<HTMLInputElement>(
        "[data-test-create-control]",
      )!;
      expect(dom.window.document.activeElement).toBe(control);
      expect(
        dom.window.document.querySelectorAll(
          "[data-collection-create-scroll-owner]",
        ).length,
      ).toBe(1);
      expect(progressValue(dom, "aria-valuemin")).toBe("1");
      expect(progressValue(dom, "aria-valuemax")).toBe("4");
      expect(progressValue(dom, "aria-valuenow")).toBe("1");

      await clickButton(dom, "Continue");
      expect(currentStep(dom)).toBe("second");
      expect(progressValue(dom, "aria-valuenow")).toBe("2");
      expect(
        dom.window.document.activeElement?.hasAttribute(
          "data-collection-create-step-heading",
        ),
      ).toBe(true);

      await clickButton(dom, "Mark dirty");
      await clickButton(dom, "Cancel");
      expect(
        dom.window.document.body.textContent?.includes("Discard draft?"),
      ).toBe(true);
      await clickButton(dom, "Keep editing");
      expect(currentStep(dom)).toBe("second");

      await clickButton(dom, "Cancel");
      await clickButton(dom, "Discard draft");
      await act(async () => {
        await new Promise((resolve) =>
          dom.window.requestAnimationFrame(resolve),
        );
        await nextTurn();
      });
      expect(
        dom.window.document.querySelector("[data-test-close-count]")
          ?.textContent,
      ).toBe("1");
      expect(dom.window.document.activeElement).toBe(trigger);
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

function Harness({ Flow }: { Flow: CreateFlowComponent }) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState(1);
  const [closeCount, setCloseCount] = useState(0);
  const [focusRequest, setFocusRequest] =
    useState<CollectionCreateFlowFocusRequest>({
      id: 0,
      target: "control",
    });
  const moveTo = (
    next: number,
    target: CollectionCreateFlowFocusRequest["target"],
  ) => {
    setFocusRequest((current) => ({ id: current.id + 1, target }));
    setStep(next);
  };
  const sharedProps = {
    cancelLabel: "Cancel",
    currentStep: step,
    dirty,
    discardConfirmation: {
      cancelLabel: "Keep editing",
      confirmLabel: "Discard draft",
      description: "The current draft will be lost.",
      title: "Discard draft?",
    },
    flowId: "test-flow",
    focusRequest,
    getControlFocusTarget,
    locked: false,
    progressLabel: `Step ${step} of 4`,
    stepKey: step === 1 ? "first" : "second",
    stepLabel: step === 1 ? "First" : "Second",
    title: "Create item",
    totalSteps: 4,
    onClose: () => {
      setCloseCount((count) => count + 1);
      setOpen(false);
    },
  } satisfies Omit<
    CollectionCreateFlowProps,
    "backAction" | "children" | "primaryAction"
  >;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open flow
      </button>
      <span data-test-close-count>{closeCount}</span>
      {open ? (
        <Flow
          {...sharedProps}
          backAction={
            step > 1
              ? { label: "Back", onClick: () => moveTo(step - 1, "heading") }
              : undefined
          }
          primaryAction={{
            label: "Continue",
            onClick: () => moveTo(step + 1, "heading"),
          }}
        >
          <input aria-label="Create control" data-test-create-control />
          <button type="button" onClick={() => setDirty(true)}>
            Mark dirty
          </button>
        </Flow>
      ) : null}
    </>
  );
}

function getControlFocusTarget(content: HTMLDivElement) {
  return content.querySelector<HTMLElement>("[data-test-create-control]");
}

function currentStep(dom: JSDOM) {
  return dom.window.document
    .querySelector('[data-collection-create-flow="test-flow"]')
    ?.getAttribute("data-collection-create-step");
}

function progressValue(dom: JSDOM, attribute: string) {
  return dom.window.document
    .querySelector('[data-slot="progress"]')
    ?.getAttribute(attribute);
}

function findButton(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

async function clickButton(dom: JSDOM, label: string) {
  const button = findButton(dom, label);
  await act(async () => {
    button.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await nextTurn();
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
  });
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
