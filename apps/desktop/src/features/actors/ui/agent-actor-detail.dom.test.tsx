import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";

const descriptors: readonly AgentActorAdapterDescriptor[] = [
  {
    defaultEffortLabel: "BACKEND DEFAULT EFFORT",
    defaultModelLabel: "BACKEND DEFAULT MODEL",
    id: "codex",
    label: "Codex",
    modelOptions: [{ label: "BACKEND CLIENT DEFAULT", value: null }],
  },
  {
    defaultEffortLabel: "BACKEND DEFAULT EFFORT",
    defaultModelLabel: "BACKEND DEFAULT MODEL",
    id: "claude-code",
    label: "Claude Code",
    modelOptions: [{ label: "BACKEND CLIENT DEFAULT", value: null }],
  },
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
  test("read-only Detail keeps access unique and adapter status and check visible", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const checks: AgentActorBinding["adapter"][] = [];
    const harness = await renderDetail({
      diagnostics: { codex: diagnostic("codex", "ready") },
      draft: draft("full", [binding("codex")]),
      onCheck: (adapter) => checks.push(adapter),
      runtime: { codex: bindingRuntime("codex_full_access", "full") },
    });
    try {
      expect(
        textOf(harness.dom, "[data-agent-actor-access]").includes(
          "Full access",
        ),
      ).toBe(true);
      expect(
        occurrences(
          textOf(harness.dom, "[data-agent-actor-read-only-detail]"),
          "Full access",
        ),
      ).toBe(1);
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Saving this mode",
        ) ?? false,
      ).toBe(false);
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "BACKEND BOUNDARY",
        ) ?? false,
      ).toBe(false);
      expect(findButton(harness.dom, "Check Codex").disabled).toBe(false);
      expect(
        textOf(harness.dom, '[data-agent-adapter="codex"]').includes("Ready"),
      ).toBe(true);

      await clickButton(harness.dom, "Check Codex");
      expect(checks).toEqual(["codex"]);
      expect(
        harness.dom.window.document
          .querySelector(
            '[data-agent-adapter="codex"] [data-slot="collapsible-content"]',
          )
          ?.getAttribute("data-state"),
      ).toBe("closed");

      await clickButton(harness.dom, "Show or hide Codex details");
      const detail = textOf(harness.dom, '[data-agent-adapter="codex"]');
      expect(detail.includes("Client access rules")).toBe(true);
      expect(detail.includes("Codex bypasses confirmations")).toBe(true);
      expect(detail.includes("BACKEND BOUNDARY")).toBe(false);
      expect(occurrences(detail, "Client access rules")).toBe(1);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian multi-adapter Detail localizes structured states and keeps raw evidence secondary", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const harness = await renderDetail({
      diagnostics: {
        codex: diagnostic("codex", "ready"),
        "claude-code": diagnostic(
          "claude-code",
          "unauthenticated",
          "raw claude auth detail",
        ),
      },
      draft: draft("auto", [
        binding("codex", "gpt-5.6", "high"),
        binding("claude-code"),
      ]),
      pendingAdapter: "codex",
      runtime: {
        codex: bindingRuntime("codex_auto_review", "auto"),
        "claude-code": bindingRuntime("claude_auto", "auto", true),
      },
    });
    try {
      const body = harness.dom.window.document.body.textContent ?? "";
      expect(body.includes("Автопроверка")).toBe(true);
      expect(body.includes("Основной")).toBe(true);
      expect(body.includes("Резервный")).toBe(true);
      expect(body.includes("Проверка…")).toBe(true);
      expect(body.includes("Требует внимания")).toBe(true);
      expect(body.includes("Модель: gpt-5.6")).toBe(true);
      expect(body.includes("По умолчанию клиента")).toBe(true);
      expect(
        /Full access|native boundary|first-run|Client default|Fallback|\bModel\b|\bEffort\b|BACKEND/.test(
          body,
        ),
      ).toBe(false);

      const cards = Array.from(
        harness.dom.window.document.querySelectorAll("[data-agent-adapter]"),
      );
      expect(
        cards.map((card) => card.getAttribute("data-agent-adapter")),
      ).toEqual(["codex", "claude-code"]);
      expect(findButton(harness.dom, "Проверить Codex").disabled).toBe(true);
      expect(findButton(harness.dom, "Проверить Claude Code").disabled).toBe(
        true,
      );

      await clickButton(
        harness.dom,
        "Показать или скрыть сведения о Claude Code",
      );
      const claudeDetail = textOf(
        harness.dom,
        '[data-agent-adapter="claude-code"]',
      );
      expect(claudeDetail.includes("Правила доступа клиента")).toBe(true);
      expect(
        claudeDetail.includes(
          "Claude Code может разрешить, запретить или запросить подтверждение",
        ),
      ).toBe(true);
      expect(claudeDetail.includes("Войдите в этот клиент")).toBe(true);
      expect(
        claudeDetail.indexOf("Войдите в этот клиент") <
          claudeDetail.indexOf("raw claude auth detail"),
      ).toBe(true);
      expect(claudeDetail.includes("Сохранённый уровень усилий")).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("all approval modes keep the same read-only hierarchy through loading and missing-client states", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const cases = [
      { mode: "ask" as const, native: "codex_user_review" as const },
      { mode: "auto" as const, native: "codex_auto_review" as const },
      { mode: "full" as const, native: "codex_full_access" as const },
    ];
    try {
      for (const [index, scenario] of cases.entries()) {
        const harness = await renderDetail({
          diagnostics:
            index === 0
              ? { codex: diagnostic("codex", "missing", "raw missing detail") }
              : {},
          draft: draft(scenario.mode, [binding("codex")]),
          runtime:
            index === 0
              ? {}
              : {
                  codex: bindingRuntime(scenario.native, scenario.mode),
                },
        });
        try {
          expect(
            harness.dom.window.document.querySelectorAll(
              "[data-agent-actor-access]",
            ).length,
          ).toBe(1);
          expect(
            harness.dom.window.document.querySelectorAll(
              "[data-agent-actor-adapters]",
            ).length,
          ).toBe(1);
          expect(findButton(harness.dom, "Check Codex").disabled).toBe(false);
          expect(harness.dom.window.document.querySelector("form")).toBeNull();
          if (index === 0) {
            await clickButton(harness.dom, "Show or hide Codex details");
            const content = textOf(harness.dom, '[data-agent-adapter="codex"]');
            expect(content.includes("current adapter settings")).toBe(true);
            expect(content.includes("client was not found")).toBe(true);
          }
        } finally {
          await harness.cleanup();
        }
      }
    } finally {
      await setLocale(originalLocale, { reload: false });
    }
  });
}

async function renderDetail({
  diagnostics,
  draft: value,
  onCheck = () => undefined,
  pendingAdapter = null,
  runtime,
}: {
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  onCheck?(adapter: AgentActorBinding["adapter"]): void;
  pendingAdapter?: AgentActorBinding["adapter"] | null;
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { AgentActorDetail } = await import("./agent-actor-detail");
  await act(async () => {
    root.render(
      <AgentActorDetail
        descriptors={descriptors}
        diagnostics={diagnostics}
        draft={value}
        editMode={false}
        pendingAdapter={pendingAdapter}
        runtime={runtime}
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

function draft(
  approvalMode: AgentActorDraft["approvalMode"],
  adapters: AgentActorBinding[],
): AgentActorDraft {
  return {
    adapters,
    approvalMode,
    description: "",
    id: "01arz3ndektsv4rrffq69g5fav",
    name: "Documentation Agent",
    ownerPath: "/repo",
  };
}

function binding(
  adapter: AgentActorBinding["adapter"],
  model: string | null = null,
  effort: string | null = null,
): AgentActorBinding {
  return { adapter, effort, model };
}

function bindingRuntime(
  native: AgentActorBindingRuntime["approval"]["native"],
  requested: AgentActorDraft["approvalMode"],
  invalidEffort = false,
): AgentActorBindingRuntime {
  return {
    approval: {
      danger: requested === "full",
      effectiveBoundary: "BACKEND BOUNDARY",
      label: "BACKEND LABEL",
      native,
      requested,
    },
    effortOptions: [{ label: "BACKEND CLIENT DEFAULT", value: null }],
    validation: {
      issues: invalidEffort
        ? [
            {
              code: "unknown_effort_selector",
              field: "effort",
              message: "BACKEND VALIDATION",
            },
          ]
        : [],
      status: invalidEffort ? "unavailable" : "valid",
    },
  };
}

function diagnostic(
  adapter: AgentActorBinding["adapter"],
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

function occurrences(value: string, query: string) {
  return value.split(query).length - 1;
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
