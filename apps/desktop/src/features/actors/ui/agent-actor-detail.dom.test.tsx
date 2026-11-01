import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorBinding,
  AgentActorDraft,
  AgentAdapterId,
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
  test("read-only Detail shows the one binding agent with its status and check, without approval modes", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const checks: AgentAdapterId[] = [];
    const harness = await renderDetail({
      diagnostics: { codex: diagnostic("codex", "ready") },
      draft: draft(codexBinding()),
      onCheck: (adapter) => checks.push(adapter),
    });
    try {
      const detail = textOf(harness.dom, "[data-agent-actor-read-only-detail]");
      expect(
        harness.dom.window.document.querySelector("[data-agent-actor-access]"),
      ).toBeNull();
      expect(
        /Full access|Ask|Primary|Fallback|gpt-6\.1-sol|Model/.test(detail),
      ).toBe(false);
      expect(
        harness.dom.window.document.querySelectorAll("[data-agent-adapter]")
          .length,
      ).toBe(1);
      expect(
        textOf(harness.dom, '[data-agent-adapter="codex"]').includes("Ready"),
      ).toBe(true);
      await clickButton(harness.dom, "Check Codex");
      expect(checks).toEqual(["codex"]);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("the participant's agent is named without a check", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const harness = await renderDetail({
      diagnostics: {},
      draft: draft({ kind: "participant" }),
    });
    try {
      expect(textOf(harness.dom, "[data-agent-actor-binding]")).toBe(
        "Агент участника",
      );
      expect(
        harness.dom.window.document.querySelector("[data-agent-adapter]"),
      ).toBeNull();
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("a binding of an agent this build does not know is shown unavailable with its reason", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const harness = await renderDetail({
      diagnostics: {},
      draft: draft({ agent: "future-agent", kind: "agent", settings: [] }),
    });
    try {
      expect(textOf(harness.dom, "[data-agent-actor-binding]")).toBe(
        "future-agent",
      );
      expect(
        textOf(harness.dom, "[data-agent-adapter-unknown]").includes(
          "not part of this version of Svode",
        ),
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("the edit form offers only the agent, keeping its values and mode as they are", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const harness = await renderDetail({
      diagnostics: {},
      draft: draft(codexBinding()),
      editMode: true,
    });
    try {
      const document = harness.dom.window.document;
      expect(
        document.querySelectorAll('[data-slot="select-trigger"]').length,
      ).toBe(1);
      const labels = Array.from(
        document.querySelectorAll('[data-slot="field-label"]'),
      ).map((label) => label.textContent?.trim());
      expect(labels).toEqual(["Name", "Description", "Agent"]);
      expect(document.body.textContent?.includes("Approval")).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });
}

async function renderDetail({
  diagnostics,
  draft: value,
  editMode = false,
  onCheck = () => undefined,
  pendingAdapter = null,
}: {
  diagnostics: Readonly<
    Partial<Record<AgentAdapterId, AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  editMode?: boolean;
  onCheck?(adapter: AgentAdapterId): void;
  pendingAdapter?: AgentAdapterId | null;
}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { AgentActorDetail } = await import("./agent-actor-detail");
  await act(async () => {
    root.render(
      <AgentActorDetail
        agents={agents}
        diagnostics={diagnostics}
        draft={value}
        editMode={editMode}
        pendingAdapter={pendingAdapter}
        onChange={() => undefined}
        onCheck={onCheck}
        onSave={() => undefined}
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

function diagnostic(
  adapter: AgentAdapterId,
  status: AgentActorAdapterDiagnostic["status"],
  message: string | null = null,
): AgentActorAdapterDiagnostic {
  return {
    adapter,
    authenticated:
      status === "ready" ? true : status === "unauthenticated" ? false : null,
    code: status === "ready" ? null : `adapter_${status}`,
    executablePath: status === "missing" ? null : `/bin/${adapter}`,
    message,
    status,
    version: status === "missing" ? null : "1.0",
  };
}

function findButton(dom: JSDOM, ariaLabel: string) {
  const button = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="${ariaLabel}"]`,
  );
  if (!button) throw new Error(`Button not found: ${ariaLabel}`);
  return button;
}

async function clickButton(dom: JSDOM, ariaLabel: string) {
  const button = findButton(dom, ariaLabel);
  await act(async () => {
    button.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await nextTurn();
  });
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
