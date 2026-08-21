import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { createAgentActorDraft } from "../model/agent-actor-draft";
import type { AgentActorBinding } from "../model/agent-actor-types";
import { useAgentActorDraftRuntime } from "./use-agent-actor-draft-runtime";

test("late binding inspection cannot replace the current adapter generation", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const inspections = new Map<
    AgentActorBinding["adapter"],
    ReturnType<typeof deferred<unknown>>
  >();
  mockNativeIpc((command, args) => {
    if (command !== "agent_actors_inspect_binding") {
      throw new Error(`Unexpected command: ${command}`);
    }
    const adapter = (args as { binding: AgentActorBinding }).binding.adapter;
    const inspection = deferred<unknown>();
    inspections.set(adapter, inspection);
    return inspection.promise;
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<RuntimeHarness />);
      await nextTurn();
    });
    expect(textOf(dom, "[data-runtime-phase]")).toBe("loading");

    await act(async () => {
      findButton(dom, "Use Claude Code").click();
      await nextTurn();
    });
    await act(async () => {
      inspections.get("claude-code")?.resolve(runtimeInspection("claude-code"));
      await nextTurn();
    });
    expect(textOf(dom, "[data-runtime-phase]")).toBe("ready");
    expect(textOf(dom, "[data-runtime-adapters]")).toBe("claude-code");

    await act(async () => {
      inspections.get("codex")?.resolve(runtimeInspection("codex"));
      await nextTurn();
    });
    expect(textOf(dom, "[data-runtime-adapters]")).toBe("claude-code");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function RuntimeHarness() {
  const [draft, setDraft] = useState(() => createAgentActorDraft("/repo"));
  const state = useAgentActorDraftRuntime(draft);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setDraft({
            ...draft,
            adapters: [{ adapter: "claude-code", effort: null, model: null }],
          })
        }
      >
        Use Claude Code
      </button>
      <span data-runtime-phase>{state.phase}</span>
      <span data-runtime-adapters>
        {Object.keys(state.runtime).sort().join(",")}
      </span>
    </>
  );
}

function runtimeInspection(adapter: AgentActorBinding["adapter"]) {
  return {
    approval: {
      danger: false,
      effectiveBoundary: `${adapter} boundary`,
      label: "Ask",
      native: adapter === "codex" ? "codex_user_review" : "claude_default",
      requested: "ask",
    },
    effortOptions: [{ label: "Client default", value: null }],
    validation: { issues: [], status: "valid" },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function findButton(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
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
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
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
