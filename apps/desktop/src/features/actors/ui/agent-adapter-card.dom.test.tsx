import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type {
  AgentActorAdapterDescriptor,
  AgentActorApprovalMapping,
  AgentActorApprovalMode,
  AgentActorBinding,
  AgentActorSelectOption,
} from "../model/agent-actor-types";

const clientDefault: AgentActorSelectOption = {
  label: "Client default",
  value: null,
};

const codex: AgentActorAdapterDescriptor = {
  defaultEffortLabel: "Client default",
  defaultModelLabel: "Client default",
  id: "codex",
  label: "Codex",
  modelOptions: [clientDefault, { label: "GPT-5.6", value: "gpt-5.6" }],
};

const hermes: AgentActorAdapterDescriptor = {
  defaultEffortLabel: "Client default",
  defaultModelLabel: "Client default",
  id: "hermes",
  label: "Hermes",
  modelOptions: [clientDefault],
};

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
  test("an agent without selectors runs with its native default and shows its boundary", async () => {
    const harness = await renderCard({
      approvalMapping: mapping("hermes_accept_edits", "auto"),
      approvalMode: "auto",
      binding: binding("hermes"),
      descriptor: hermes,
      effortOptions: [clientDefault],
      locale: "en",
    });
    try {
      const card = harness.text();
      expect(harness.labels()).toEqual([]);
      expect(card.includes("Client default · Client default")).toBe(true);
      expect(
        card.includes(
          "Hermes allows edits in the workspace and temporary folders",
        ),
      ).toBe(true);
      expect(
        harness.dom.window.document.querySelector(
          "[data-agent-adapter-no-mode-equivalent]",
        ),
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("an agent with selectors keeps its model and effort fields", async () => {
    const harness = await renderCard({
      approvalMapping: mapping("codex_user_review", "ask"),
      approvalMode: "ask",
      binding: binding("codex"),
      descriptor: codex,
      effortOptions: [clientDefault, { label: "Low", value: "low" }],
      locale: "en",
    });
    try {
      expect(harness.labels()).toEqual(["Model", "Effort"]);
    } finally {
      await harness.cleanup();
    }
  });

  test("a stored selector the agent does not map stays visible to be reset", async () => {
    const harness = await renderCard({
      approvalMapping: mapping("hermes_default", "ask"),
      approvalMode: "ask",
      binding: binding("hermes", "gpt-5.6-luna"),
      descriptor: hermes,
      effortOptions: [clientDefault],
      locale: "en",
    });
    try {
      expect(harness.labels()).toEqual(["Model"]);
    } finally {
      await harness.cleanup();
    }
  });

  test("a binding without an equivalent of the Actor mode names why it is unavailable", async () => {
    for (const [locale, expected] of [
      [
        "en",
        "Unavailable: Hermes has no equivalent of “Full access”. The binding stays and works with another access mode.",
      ],
      [
        "ru",
        "Недоступно: у Hermes нет эквивалента режима «Полный доступ». Привязка сохраняется и работает при другом режиме доступа.",
      ],
    ] as const) {
      const harness = await renderCard({
        approvalMapping: null,
        approvalMode: "full",
        binding: binding("hermes"),
        descriptor: hermes,
        effortOptions: [clientDefault],
        locale,
      });
      try {
        expect(
          harness.dom.window.document.querySelector(
            "[data-agent-adapter-no-mode-equivalent]",
          )?.textContent,
        ).toBe(expected);
      } finally {
        await harness.cleanup();
      }
    }
  });
}

async function renderCard({
  approvalMapping,
  approvalMode,
  binding: value,
  descriptor,
  effortOptions,
  locale,
}: {
  approvalMapping: AgentActorApprovalMapping | null;
  approvalMode: AgentActorApprovalMode;
  binding: AgentActorBinding;
  descriptor: AgentActorAdapterDescriptor;
  effortOptions: readonly AgentActorSelectOption[];
  locale: "en" | "ru";
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
        approvalMapping={approvalMapping}
        approvalMode={approvalMode}
        binding={value}
        canRemove
        checkDisabled={false}
        descriptor={descriptor}
        effortOptions={effortOptions}
        pending={false}
        primary
        readOnly={false}
        validation={{ issues: [], status: "valid" }}
        onChange={() => undefined}
        onCheck={() => undefined}
        onMakePrimary={() => undefined}
        onRemove={() => undefined}
      />,
    );
    await nextTurn();
  });
  const card = () =>
    dom.window.document.querySelector(
      `[data-agent-adapter="${value.adapter}"]`,
    );
  return {
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
    labels: () =>
      Array.from(
        card()?.querySelectorAll('[data-slot="field-label"]') ?? [],
      ).map((label) => label.textContent?.trim()),
    text: () => card()?.textContent ?? "",
  };
}

function binding(
  adapter: AgentActorBinding["adapter"],
  model: string | null = null,
): AgentActorBinding {
  return { adapter, effort: null, model };
}

function mapping(
  native: AgentActorApprovalMapping["native"],
  requested: AgentActorApprovalMode,
): AgentActorApprovalMapping {
  return {
    danger: false,
    effectiveBoundary: "BACKEND BOUNDARY",
    label: "BACKEND LABEL",
    native,
    requested,
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
