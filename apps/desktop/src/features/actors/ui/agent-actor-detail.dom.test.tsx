import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type {
  AgentActorAgentOption,
  AgentActorBinding,
  AgentActorDraft,
} from "../model/agent-actor-types";

const agents: readonly AgentActorAgentOption[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "hermes", label: "Hermes" },
];

const isolatedDetailDomProcess =
  process.env.SVODE_AGENT_ACTOR_DETAIL_DOM_PROCESS === "1";

if (!isolatedDetailDomProcess) {
  test("Agent Actor read-only Detail DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_AGENT_ACTOR_DETAIL_DOM_PROCESS: "1",
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
  test("read-only Detail shows the one binding row without adapter cards, checks or approval mode variants", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const harness = await renderDetail({ draft: draft(codexBinding()) });
    try {
      const detail = textOf(harness.dom, "[data-agent-actor-read-only-detail]");
      expect(
        harness.dom.window.document.querySelectorAll("[data-agent-adapter]")
          .length,
      ).toBe(0);
      expect(/Full access|Ask|Primary|Fallback|Check/.test(detail)).toBe(false);
      // The last declarations name the model.
      expect(textOf(harness.dom, "[data-agent-actor-binding]")).toBe(
        "GPT-6.1 Sol",
      );
      expect(harness.commands.includes("agent_runtime_hold_draft")).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("the participant's agent is named in the locale", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const harness = await renderDetail({
      draft: draft({ kind: "participant" }),
    });
    try {
      expect(textOf(harness.dom, "[data-agent-actor-binding]")).toBe(
        "Агент участника",
      );
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("a binding this version cannot bind is shown unavailable with its reason", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const harness = await renderDetail({
      draft: draft({ agent: "custom-mine", kind: "agent", settings: [] }),
    });
    try {
      expect(textOf(harness.dom, "[data-agent-actor-binding]")).toBe(
        "custom-mine",
      );
      expect(
        textOf(harness.dom, "[data-agent-adapter-unknown]").includes(
          "cannot bind this agent",
        ),
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("the edit form has the name, the description and the binding row, without a Select of the agent, model or effort", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const harness = await renderDetail({
      draft: draft(codexBinding()),
      editMode: true,
    });
    try {
      const document = harness.dom.window.document;
      expect(
        document.querySelectorAll('[data-slot="select-trigger"]').length,
      ).toBe(0);
      const labels = Array.from(
        document.querySelectorAll('[data-slot="field-label"]'),
      ).map((label) => label.textContent?.trim());
      expect(labels).toEqual(["Name", "Description", "Agent"]);
      expect(
        document.querySelector("button[data-agent-actor-binding]") === null,
      ).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });
}

async function renderDetail({
  draft: value,
  editMode = false,
}: {
  draft: AgentActorDraft;
  editMode?: boolean;
}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const commands: string[] = [];
  mockNativeIpc(
    (command, args) => {
      commands.push(command);
      if (command === "agent_adapters_list_identities") {
        return agents.map((agent) => ({
          id: agent.id,
          displayName: agent.label,
        }));
      }
      if (command === "agent_default_get") return null;
      if (command === "agent_runtime_last_declarations") {
        return (args as { agent: string }).agent === "codex"
          ? [codexDeclaration()]
          : [];
      }
      if (command === "agent_runtime_hold_draft") {
        return {
          hold: 1,
          check: { state: "auth_required", message: "" },
          session: null,
          keepsValuesUntilSend: false,
        };
      }
      if (command === "agent_runtime_release_draft") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { AgentActorDetail } = await import("./agent-actor-detail");
  await act(async () => {
    root.render(
      <AgentActorDetail
        agents={agents}
        draft={value}
        editMode={editMode}
        offers={null}
        onChange={() => undefined}
        onOpenAgentSettings={() => undefined}
        onRecheckOffers={() => undefined}
        onSave={() => undefined}
      />,
    );
    await nextTurn();
    await nextTurn();
  });
  return {
    cleanup: async () => {
      await act(async () => {
        root.unmount();
        await nextTurn();
      });
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
    commands,
    dom,
  };
}

function codexDeclaration() {
  return {
    agent: "codex",
    model: "gpt-6.1-sol",
    declaredAt: 1,
    agentVersion: "0.163.0",
    settings: [
      {
        id: "model",
        name: "Model",
        description: null,
        category: "model",
        currentValue: "gpt-6.1-sol",
        options: [
          { value: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: null },
        ],
      },
    ],
  };
}

function codexBinding(): AgentActorBinding {
  return {
    agent: "codex",
    kind: "agent",
    settings: [{ setting: "model", value: "gpt-6.1-sol" }],
  };
}

function draft(binding: AgentActorBinding): AgentActorDraft {
  return {
    binding,
    description: "",
    id: "01arz3ndektsv4rrffq69g5fav",
    mode: { agent: "codex", setting: "mode", value: "agent" },
    name: "Documentation Agent",
    ownerPath: "/repo",
  };
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
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    SVGElement: dom.window.SVGElement,
    CustomEvent: dom.window.CustomEvent,
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
