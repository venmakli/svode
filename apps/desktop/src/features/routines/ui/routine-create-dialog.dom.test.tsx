import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { RoutineDefinition } from "../model/types";

type DialogComponent =
  typeof import("./routine-create-dialog").RoutineCreateDialog;

const actor = {
  description: null,
  label: "Documentation Agent",
  ownerLabel: "root",
  value: "agent:01arz3ndektsv4rrffq69g5fav" as const,
};

const isolatedDialogDomProcess =
  process.env.SVODE_ROUTINE_CREATE_DIALOG_DOM_PROCESS === "1";

if (!isolatedDialogDomProcess) {
  test("routine create journey DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_ROUTINE_CREATE_DIALOG_DOM_PROCESS: "1",
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
  const bunMock = (
    bunTest as typeof bunTest & {
      mock: { module(specifier: string, factory: () => unknown): void };
    }
  ).mock;
  bunMock.module("@/features/editor", () => ({
    ControlledMarkdownEditor: ({
      onChange,
      value,
    }: {
      onChange(value: string): void;
      value: string;
    }) => (
      <textarea
        aria-label="Routine content"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    ),
  }));

  test("journey gates steps and performs one mutation only from Review", async () => {
    const harness = await renderHarness({ pendingOnSubmit: true });
    try {
      expect(currentStep(harness.dom)).toBe("basics");
      expect(
        harness.dom.window.document.querySelectorAll(
          "[data-routine-create-scroll-owner]",
        ).length,
      ).toBe(1);
      expect(
        harness.dom.window.document.body.style.pointerEvents === "none",
      ).toBe(false);
      expect(
        harness.dom.window.document.body.hasAttribute("data-scroll-locked"),
      ).toBe(false);

      await clickButton(harness.dom, "Continue");
      const title = harness.dom.window.document.querySelector<HTMLInputElement>(
        '[data-routine-create-focus="basics"]',
      )!;
      expect(currentStep(harness.dom)).toBe("basics");
      expect(title.getAttribute("aria-invalid")).toBe("true");
      expect(harness.dom.window.document.activeElement).toBe(title);

      await clickButton(harness.dom, "Fill title");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("trigger");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("action");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("review");
      expect(textOf(harness.dom, "[data-submit-count]")).toBe("0");
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Documentation Agent",
        ),
      ).toBe(true);

      const submit = findButton(harness.dom, "Create routine");
      await act(async () => {
        submit.click();
        submit.click();
        await nextTurn();
      });
      expect(textOf(harness.dom, "[data-submit-count]")).toBe("1");
      expect(findButton(harness.dom, "Creating…").disabled).toBe(true);
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"] [data-slot="dialog-close"]',
        ),
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("dirty cancel uses one discard guard and never submits the draft", async () => {
    const harness = await renderHarness({ startOpen: false });
    try {
      const trigger = findButton(harness.dom, "Open create");
      trigger.focus();
      await clickButton(harness.dom, "Open create");
      await clickButton(harness.dom, "Fill title");
      await clickButton(harness.dom, "Cancel");

      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Discard unsaved routine changes?",
        ),
      ).toBe(true);
      expect(textOf(harness.dom, "[data-submit-count]")).toBe("0");

      await clickButton(harness.dom, "Keep editing");
      expect(currentStep(harness.dom)).toBe("basics");
      await clickButton(harness.dom, "Cancel");
      await clickButton(harness.dom, "Discard draft");
      await act(async () => {
        await new Promise((resolve) =>
          harness.dom.window.requestAnimationFrame(resolve),
        );
        await nextTurn();
      });
      expect(textOf(harness.dom, "[data-close-count]")).toBe("1");
      expect(harness.dom.window.document.activeElement).toBe(trigger);
    } finally {
      await harness.cleanup();
    }
  });

  test("authoritative name conflict keeps the draft and returns focus to Basics", async () => {
    const harness = await renderHarness({ conflictOnSubmit: true });
    try {
      await clickButton(harness.dom, "Fill title");
      await clickButton(harness.dom, "Continue");
      await clickButton(harness.dom, "Continue");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("review");

      await clickButton(harness.dom, "Create routine");

      const title = harness.dom.window.document.querySelector<HTMLInputElement>(
        '[data-routine-create-focus="basics"]',
      )!;
      expect(currentStep(harness.dom)).toBe("basics");
      expect(title.value).toBe("Review changes");
      expect(title.getAttribute("aria-invalid")).toBe("true");
      expect(harness.dom.window.document.activeElement).toBe(title);
      expect(
        harness.dom.window.document.body.textContent?.includes(
          ".routines/existing.md",
        ),
      ).toBe(true);
      expect(textOf(harness.dom, "[data-submit-count]")).toBe("1");
    } finally {
      await harness.cleanup();
    }
  });

  test("timezone popup remains wheel-scrollable inside the create dialog", async () => {
    const harness = await renderHarness();
    try {
      await clickButton(harness.dom, "Fill title");
      await clickButton(harness.dom, "Continue");
      await clickButton(harness.dom, "Use schedule");

      const input = harness.dom.window.document.querySelector<HTMLInputElement>(
        "#routine-create-timezone",
      )!;
      await act(async () => {
        input.focus();
        input.dispatchEvent(
          new harness.dom.window.MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
          }),
        );
        await nextTurn();
        await new Promise((resolve) =>
          harness.dom.window.requestAnimationFrame(resolve),
        );
      });

      const list = harness.dom.window.document.querySelector<HTMLElement>(
        '[data-slot="combobox-list"]',
      )!;
      const wheel = new harness.dom.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      });
      expect(list.dispatchEvent(wheel)).toBe(true);
      expect(wheel.defaultPrevented).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
}

function JourneyHarness({
  Dialog,
  conflictOnSubmit = false,
  pendingOnSubmit = false,
  startOpen,
}: {
  Dialog: DialogComponent;
  conflictOnSubmit?: boolean;
  pendingOnSubmit?: boolean;
  startOpen: boolean;
}) {
  const initial = validDefinition();
  const [open, setOpen] = useState(startOpen);
  const [definition, setDefinition] = useState(initial);
  const [pending, setPending] = useState(false);
  const [submitCount, setSubmitCount] = useState(0);
  const [closeCount, setCloseCount] = useState(0);
  const [nameError, setNameError] = useState<string | null>(null);
  const changeDefinition = (next: RoutineDefinition) => {
    setDefinition(next);
    setNameError(null);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          changeDefinition(validDefinition());
          setOpen(true);
        }}
      >
        Open create
      </button>
      <button
        type="button"
        onClick={() =>
          changeDefinition({ ...definition, name: "Review changes" })
        }
      >
        Fill title
      </button>
      <button
        type="button"
        onClick={() =>
          changeDefinition({
            ...definition,
            enabled: false,
            trigger: {
              cron: "0 9 * * 1-5",
              missedRuns: "skip",
              timeBasis: { mode: "local" },
              type: "schedule",
            },
          })
        }
      >
        Use schedule
      </button>
      <span data-submit-count>{submitCount}</span>
      <span data-close-count>{closeCount}</span>
      {open ? (
        <Dialog
          automaticAuthority={false}
          collectionOwner
          definition={definition}
          error={null}
          executorError={null}
          executorLoading={false}
          executors={[actor]}
          initialDefinition={initial}
          nameError={nameError}
          ownerLabel="Collection · Tasks"
          pending={pending}
          retryBlocked={false}
          onChange={changeDefinition}
          onClose={() => {
            setCloseCount((count) => count + 1);
            setOpen(false);
          }}
          onRetryExecutors={() => undefined}
          onSubmit={() => {
            setSubmitCount((count) => count + 1);
            if (conflictOnSubmit) {
              setNameError(
                "This name is already used in this owner by .routines/existing.md. Choose a unique name.",
              );
            }
            if (pendingOnSubmit) setPending(true);
          }}
        />
      ) : null}
    </>
  );
}

async function renderHarness({
  conflictOnSubmit,
  pendingOnSubmit,
  startOpen = true,
}: {
  conflictOnSubmit?: boolean;
  pendingOnSubmit?: boolean;
  startOpen?: boolean;
} = {}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  dom.window.document.querySelector<HTMLButtonElement>("#external")?.focus();
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { RoutineCreateDialog } = await import("./routine-create-dialog");
  await act(async () => {
    root.render(
      <JourneyHarness
        Dialog={RoutineCreateDialog}
        conflictOnSubmit={conflictOnSubmit}
        pendingOnSubmit={pendingOnSubmit}
        startOpen={startOpen}
      />,
    );
    await nextTurn();
  });
  return {
    cleanup: async () => {
      await act(async () => {
        root.unmount();
        await nextTurn();
      });
      restoreGlobals();
      dom.window.close();
    },
    dom,
  };
}

function validDefinition(): RoutineDefinition {
  return {
    action: { executor: actor.value, type: "run_agent" },
    body: "Review changes.",
    description: "",
    enabled: null,
    name: "",
    trigger: { type: "manual" },
  };
}

function currentStep(dom: JSDOM) {
  return dom.window.document
    .querySelector("[data-routine-create-journey]")
    ?.getAttribute("data-routine-create-step");
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

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function createDom() {
  return new JSDOM(
    '<!doctype html><html><body><button id="external">External</button><div id="app"></div></body></html>',
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
    WheelEvent: dom.window.WheelEvent,
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
