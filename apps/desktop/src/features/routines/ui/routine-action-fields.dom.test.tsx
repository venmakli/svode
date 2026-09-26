import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";

import type { RoutineDefinition } from "../model/types";

const ref = "agent:01arz3ndektsv4rrffq69g5fav";
const loaded: AgentActorOptionsState = {
  ambiguous: [],
  error: null,
  incomplete: false,
  loading: false,
  options: [
    {
      description: null,
      label: "Documentation Agent",
      ownerLabel: "Project",
      value: ref,
    },
  ],
};
const definition: RoutineDefinition = {
  action: { executor: ref, type: "run_agent" },
  body: "",
  description: "",
  enabled: null,
  name: "Review",
  trigger: { type: "manual" },
};

const isolatedDomProcess =
  process.env.SVODE_ROUTINE_ACTION_FIELDS_DOM_PROCESS === "1";

// Radix picks its layout-effect hook at module load, so the Select needs a
// process where the DOM globals exist before the first import.
if (!isolatedDomProcess) {
  test("routine action fields DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_ROUTINE_ACTION_FIELDS_DOM_PROCESS: "1",
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
  test(
    "executor Select shows the agent as avatar and name in every state",
    selectScenario,
  );
}

async function selectScenario() {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const { RoutineActionFields } = await import("./routine-action-fields");
  const root = createRoot(dom.window.document.getElementById("app")!);
  const render = async (executors: AgentActorOptionsState) => {
    await act(async () => {
      root.render(
        <RoutineActionFields
          definition={definition}
          executors={executors}
          idPrefix="routine-test"
          issues={new Set()}
          onChange={() => undefined}
        />,
      );
    });
    const trigger = dom.window.document.querySelector(
      '[data-slot="select-trigger"]',
    )!;
    return {
      error:
        dom.window.document.querySelector('[data-slot="field-error"]')
          ?.textContent ?? null,
      invalid: trigger.getAttribute("aria-invalid"),
      text: trigger.textContent ?? "",
      trigger,
    };
  };

  try {
    const resolved = await render(loaded);
    expect(String(resolved.text).includes("Documentation Agent")).toBe(true);
    expect(resolved.trigger.querySelector("[data-agent-avatar]") === null).toBe(
      false,
    );
    expect(String(resolved.text).includes(ref)).toBe(false);
    expect(resolved.error).toBeNull();

    const renamed = await render({
      ...loaded,
      options: [{ ...loaded.options[0]!, label: "Docs Writer" }],
    });
    expect(String(renamed.text).includes("Docs Writer")).toBe(true);

    const empty = { ...loaded, options: [] };
    const loading = await render({ ...empty, loading: true });
    expect(String(loading.text).includes(ref)).toBe(false);
    expect(loading.error).toBeNull();

    const missing = await render(empty);
    expect(String(missing.text).includes("Agent not found")).toBe(true);
    expect(String(missing.text).includes(ref)).toBe(false);
    expect(missing.invalid).toBe("true");
    expect(missing.error).toBe(
      "The saved agent is no longer available. Select another one.",
    );

    const ambiguous = await render({ ...empty, ambiguous: [ref] });
    expect(
      String(ambiguous.text).includes(
        "Agent is defined in both this space and the project",
      ),
    ).toBe(true);
    expect(ambiguous.invalid).toBe("true");
    expect(String(ambiguous.error).includes("defined in both this space")).toBe(
      true,
    );
    expect(ambiguous.error === missing.error).toBe(false);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
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
