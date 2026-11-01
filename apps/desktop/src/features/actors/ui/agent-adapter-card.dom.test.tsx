import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type { AgentActorAdapterDiagnostic } from "../model/agent-actor-types";

const isolatedCardDomProcess =
  process.env.SVODE_AGENT_ADAPTER_CARD_DOM_PROCESS === "1";

if (!isolatedCardDomProcess) {
  test("Agent adapter card DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_AGENT_ADAPTER_CARD_DOM_PROCESS: "1",
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
  test("the card shows only the agent with its readiness, without selectors or approval modes", async () => {
    const checks: string[] = [];
    const harness = await renderCard({
      diagnostic: undefined,
      locale: "en",
      onCheck: () => checks.push("codex"),
    });
    try {
      const card = harness.card();
      expect(card?.textContent?.includes("Codex")).toBe(true);
      expect(
        card?.querySelectorAll('[data-slot="select-trigger"]').length,
      ).toBe(0);
      expect(card?.querySelectorAll('[data-slot="field-label"]').length).toBe(
        0,
      );
      expect(
        /Model|Effort|Primary|Fallback|approval/i.test(card?.textContent ?? ""),
      ).toBe(false);
      await act(async () => {
        harness.button()?.click();
        await nextTurn();
      });
      expect(checks).toEqual(["codex"]);
    } finally {
      await harness.cleanup();
    }
  });

  test("a failed check names why the agent is not ready", async () => {
    const harness = await renderCard({
      diagnostic: {
        adapter: "codex",
        authenticated: null,
        code: "adapter_missing",
        executablePath: null,
        message: "raw client detail",
        status: "missing",
        version: null,
      },
      locale: "ru",
      onCheck: () => undefined,
    });
    try {
      const alert = harness.dom.window.document.querySelector(
        "[data-agent-adapter-diagnostic]",
      );
      expect(alert?.textContent?.includes("Клиент не найден")).toBe(true);
      expect(alert?.textContent?.includes("raw client detail")).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
}

async function renderCard({
  diagnostic,
  locale,
  onCheck,
}: {
  diagnostic: AgentActorAdapterDiagnostic | undefined;
  locale: "en" | "ru";
  onCheck(): void;
}) {
  const originalLocale = getLocale();
  await setLocale(locale, { reload: false });
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { AgentAdapterCard } = await import("./agent-adapter-card");
  await act(async () => {
    root.render(
      <AgentAdapterCard
        agent="codex"
        checkDisabled={false}
        diagnostic={diagnostic}
        label="Codex"
        pending={false}
        readOnly={false}
        onCheck={onCheck}
      />,
    );
    await nextTurn();
  });
  const card = () =>
    dom.window.document.querySelector('[data-agent-adapter="codex"]');
  return {
    button: () => card()?.querySelector("button") ?? null,
    card,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
        await nextTurn();
      });
      restoreGlobals();
      dom.window.close();
      await setLocale(originalLocale, { reload: false });
    },
    dom,
  };
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
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
