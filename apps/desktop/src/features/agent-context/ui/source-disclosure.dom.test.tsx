import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { instructionDetailProvenance } from "../model/detail-provenance";
import type { AgentContextInstructionRow } from "../model/types";
import { AgentContextSourceDisclosure } from "./source-disclosure";

const instruction: AgentContextInstructionRow = {
  adapterId: "codex",
  body: "# Project instructions",
  canonicalPath: "/workspace/AGENTS.md",
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  health: "normal",
  healthReasons: [],
  id: "instruction-a",
  linkKind: "direct",
  linkTargetPath: null,
  location: "space",
  ownerPath: "/workspace",
  precedence: 1,
  references: [],
  resolution: "selected",
  role: "codex_directory_precedence",
  support: "client_native",
  truncated: false,
};

test("source disclosure stays open across refresh and resets for a new artifact", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await render(instructionDetailProvenance(instruction));

    let trigger = sourceTrigger(dom);
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      dom.window.document.body.textContent?.includes("/workspace/AGENTS.md"),
    ).toBe(false);

    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });

    trigger = sourceTrigger(dom);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.window.document.activeElement).toBe(trigger);
    expect(pathOccurrences(dom, "/workspace/AGENTS.md")).toBe(1);

    await render(
      instructionDetailProvenance({
        ...instruction,
        body: "# Refreshed instructions",
        health: "degraded",
        healthReasons: ["Preview changed during refresh"],
      }),
    );
    expect(sourceTrigger(dom).getAttribute("aria-expanded")).toBe("true");
    expect(
      dom.window.document.body.textContent?.includes(
        "Preview changed during refresh",
      ),
    ).toBe(true);

    await render(
      instructionDetailProvenance({
        ...instruction,
        canonicalPath: "/home/user/.codex/AGENTS.md",
        discoveryPath: "/home/user/.codex/AGENTS.md",
        id: "instruction-b",
        location: "global",
        ownerPath: "/home/user/.codex",
      }),
    );
    expect(sourceTrigger(dom).getAttribute("aria-expanded")).toBe("false");
    expect(
      dom.window.document.body.textContent?.includes(
        "/home/user/.codex/AGENTS.md",
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }

  async function render(
    provenance: ReturnType<typeof instructionDetailProvenance>,
  ) {
    await act(async () => {
      root.render(<AgentContextSourceDisclosure provenance={provenance} />);
    });
  }
});

function sourceTrigger(dom: JSDOM): HTMLButtonElement {
  return dom.window.document.querySelector(
    "[data-agent-context-source-disclosure] button",
  )!;
}

function pathOccurrences(dom: JSDOM, path: string): number {
  return Array.from(dom.window.document.querySelectorAll("code")).filter(
    (element) => element.textContent === path,
  ).length;
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
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
