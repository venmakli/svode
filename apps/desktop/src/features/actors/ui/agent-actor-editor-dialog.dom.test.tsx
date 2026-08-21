import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { createAgentActorDraft } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDescriptor,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";

type EditorComponent =
  typeof import("./agent-actor-editor-dialog").AgentActorEditorDialog;

const descriptors: readonly AgentActorAdapterDescriptor[] = [
  {
    defaultEffortLabel: "Medium",
    defaultModelLabel: "GPT default",
    id: "codex",
    label: "Codex",
    modelOptions: [
      { label: "GPT default", value: null },
      { label: "GPT 5.6", value: "gpt-5.6" },
    ],
  },
  {
    defaultEffortLabel: "Client default",
    defaultModelLabel: "Claude default",
    id: "claude-code",
    label: "Claude Code",
    modelOptions: [
      { label: "Claude default", value: null },
      { label: "Sonnet", value: "sonnet" },
    ],
  },
];

const isolatedDialogDomProcess =
  process.env.SVODE_AGENT_ACTOR_DIALOG_DOM_PROCESS === "1";

if (!isolatedDialogDomProcess) {
  test("agent actor create journey DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_AGENT_ACTOR_DIALOG_DOM_PROCESS: "1",
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
  test("create journey validates each step, preserves draft, and submits only from Review", async () => {
    const harness = await renderHarness({ saveMode: "pending" });
    try {
      expect(currentStep(harness.dom)).toBe("identity");
      const name = harness.dom.window.document.querySelector<HTMLInputElement>(
        '[data-agent-actor-focus="identity"]',
      )!;
      expect(harness.dom.window.document.activeElement).toBe(name);

      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("identity");
      expect(name.getAttribute("aria-invalid")).toBe("true");
      expect(harness.dom.window.document.activeElement).toBe(name);

      await clickButton(harness.dom, "Fill name");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("adapters");
      expect(
        harness.dom.window.document.querySelector(
          "[data-agent-actor-create-journey] legend",
        ),
      ).toBeNull();
      expect(
        harness.dom.window.document.activeElement?.hasAttribute(
          "data-agent-actor-step-heading",
        ),
      ).toBe(true);

      await clickButton(harness.dom, "Back");
      expect(currentStep(harness.dom)).toBe("identity");
      expect(
        harness.dom.window.document.querySelector<HTMLInputElement>(
          '[data-agent-actor-focus="identity"]',
        )?.value,
      ).toBe("Documentation Agent");
      await clickButton(harness.dom, "Continue");
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("permissions");
      expect(textOf(harness.dom, "[data-save-count]")).toBe("0");

      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("review");
      expect(
        harness.dom.window.document
          .querySelector("[data-agent-actor-review]")
          ?.textContent?.includes("Documentation Agent"),
      ).toBe(true);
      expect(textOf(harness.dom, "[data-save-count]")).toBe("0");

      const submit = findButton(harness.dom, "Add agent");
      await act(async () => {
        submit.click();
        submit.click();
        await nextTurn();
      });
      expect(textOf(harness.dom, "[data-save-count]")).toBe("1");
      expect(findButton(harness.dom, "Saving…").disabled).toBe(true);
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"] [data-slot="dialog-close"]',
        ),
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("adapter disclosure keeps one editor open and Review preserves primary and device-local permission semantics", async () => {
    const initial = createAgentActorDraft("/repo/docs");
    initial.name = "Documentation Agent";
    initial.approvalMode = "full";
    initial.adapters.push({
      adapter: "claude-code",
      effort: null,
      model: "sonnet",
    });
    const harness = await renderHarness({ initial });
    try {
      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("adapters");
      expect(
        harness.dom.window.document.querySelectorAll(
          '[data-slot="collapsible-content"][data-state="open"]',
        ).length,
      ).toBe(1);

      const claudeCard = harness.dom.window.document.querySelector(
        '[data-agent-adapter="claude-code"]',
      );
      const toggleClaude = claudeCard?.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle adapter details"]',
      );
      if (!toggleClaude) throw new Error("Claude Code disclosure not found");
      await act(async () => {
        toggleClaude.click();
        await nextTurn();
      });
      expect(
        harness.dom.window.document.querySelectorAll(
          '[data-slot="collapsible-content"][data-state="open"]',
        ).length,
      ).toBe(1);
      await clickButton(harness.dom, "Make primary");
      expect(claudeCard?.textContent?.includes("Primary")).toBe(true);

      const codexCard = harness.dom.window.document.querySelector(
        '[data-agent-adapter="codex"]',
      )!;
      const toggleCodex = codexCard.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle adapter details"]',
      );
      if (!toggleCodex) throw new Error("Codex disclosure not found");
      await act(async () => {
        toggleCodex.click();
        await nextTurn();
      });
      const removeCodex = Array.from(codexCard.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Remove",
      )!;
      await act(async () => {
        removeCodex.click();
        await nextTurn();
      });
      expect(
        harness.dom.window.document.querySelector(
          '[data-agent-adapter="codex"]',
        ),
      ).toBeNull();
      expect(findButton(harness.dom, "Remove").disabled).toBe(true);

      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("permissions");
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Full access can make unrestricted changes",
        ),
      ).toBe(true);
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Claude full boundary",
        ),
      ).toBe(true);

      await clickButton(harness.dom, "Continue");
      expect(currentStep(harness.dom)).toBe("review");
      const review = harness.dom.window.document.querySelector(
        "[data-agent-actor-review]",
      )!;
      expect(review.textContent?.includes("Claude Code")).toBe(true);
      expect(review.textContent?.includes("Primary")).toBe(true);
      expect(review.textContent?.includes("Device-local")).toBe(true);
      expect(review.textContent?.includes("Claude full boundary")).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  test("dirty Escape uses one discard guard and restores focus to the create trigger", async () => {
    const harness = await renderHarness({ startOpen: false });
    try {
      const trigger = findButton(harness.dom, "Open create");
      trigger.focus();
      await clickButton(harness.dom, "Open create");
      await clickButton(harness.dom, "Fill name");

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            key: "Escape",
          }),
        );
        await nextTurn();
      });
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Discard unsaved agent changes?",
        ),
      ).toBe(true);
      expect(textOf(harness.dom, "[data-close-count]")).toBe("0");

      await clickButton(harness.dom, "Keep editing");
      expect(currentStep(harness.dom)).toBe("identity");
      expect(
        harness.dom.window.document.querySelector<HTMLInputElement>(
          '[data-agent-actor-focus="identity"]',
        )?.value,
      ).toBe("Documentation Agent");

      await clickButton(harness.dom, "Cancel");
      await clickButton(harness.dom, "Discard draft");
      await act(async () => {
        await new Promise((resolve) =>
          harness.dom.window.requestAnimationFrame(resolve),
        );
        await nextTurn();
      });
      expect(textOf(harness.dom, "[data-close-count]")).toBe("1");
      expect(harness.dom.window.document.activeElement === trigger).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  test("repository access and mutation failures remain inline on Review with the draft intact", async () => {
    const accessHarness = await renderHarness({
      initial: validDraft(),
      saveMode: "access",
    });
    try {
      await navigateToReview(accessHarness.dom);
      await clickButton(accessHarness.dom, "Add agent");
      expect(currentStep(accessHarness.dom)).toBe("review");
      expect(
        accessHarness.dom.window.document.querySelector(
          "[data-actor-access-inline-status]",
        ) === null,
      ).toBe(false);
      expect(
        accessHarness.dom.window.document.querySelector(
          "[data-actor-access-preflight]",
        ),
      ).toBeNull();
      await clickButton(accessHarness.dom, "Check access");
      expect(textOf(accessHarness.dom, "[data-verify-count]")).toBe("1");
      expect(currentStep(accessHarness.dom)).toBe("review");
    } finally {
      await accessHarness.cleanup();
    }

    const failureHarness = await renderHarness({
      initial: validDraft(),
      saveMode: "failure",
    });
    try {
      await navigateToReview(failureHarness.dom);
      await clickButton(failureHarness.dom, "Add agent");
      expect(currentStep(failureHarness.dom)).toBe("review");
      expect(
        failureHarness.dom.window.document.body.textContent?.includes(
          "Catalog changed; retry",
        ),
      ).toBe(true);
      expect(
        failureHarness.dom.window.document.body.textContent?.includes(
          "Documentation Agent",
        ),
      ).toBe(true);
      await clickButton(failureHarness.dom, "Add agent");
      expect(textOf(failureHarness.dom, "[data-save-count]")).toBe("2");
    } finally {
      await failureHarness.cleanup();
    }
  });
}

function JourneyHarness({
  Editor,
  initial,
  saveMode = "idle",
  startOpen,
}: {
  Editor: EditorComponent;
  initial: AgentActorDraft;
  saveMode?: "idle" | "pending" | "failure" | "access";
  startOpen: boolean;
}) {
  const [draft, setDraft] = useState<AgentActorDraft | null>(() =>
    startOpen ? cloneDraft(initial) : null,
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [accessActive, setAccessActive] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const [verifyCount, setVerifyCount] = useState(0);
  const [closeCount, setCloseCount] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFailure(null);
          setDraft(cloneDraft(initial));
        }}
      >
        Open create
      </button>
      <button
        type="button"
        onClick={() =>
          setDraft((current) =>
            current ? { ...current, name: "Documentation Agent" } : current,
          )
        }
      >
        Fill name
      </button>
      <span data-save-count>{saveCount}</span>
      <span data-verify-count>{verifyCount}</span>
      <span data-close-count>{closeCount}</span>
      <span data-draft-open>{draft ? "open" : "closed"}</span>
      <Editor
        accessRecovery={
          accessActive
            ? {
                error: null,
                snapshot: accessSnapshot(),
                verifying,
                onCancel: () => {
                  setAccessActive(false);
                  setVerifying(false);
                },
                onVerify: () => {
                  setVerifyCount((count) => count + 1);
                  setVerifying(true);
                },
              }
            : null
        }
        descriptors={descriptors}
        diagnostics={{}}
        draft={draft}
        failure={failure}
        pending={pending}
        pendingAdapter={null}
        requesting={false}
        runtime={readyRuntime(draft)}
        onChange={setDraft}
        onCheck={() => undefined}
        onClose={() => {
          setCloseCount((count) => count + 1);
          setDraft(null);
          setAccessActive(false);
        }}
        onSave={() => {
          setSaveCount((count) => count + 1);
          if (saveMode === "pending") setPending(true);
          if (saveMode === "failure") {
            setFailure("Catalog changed; retry");
          }
          if (saveMode === "access") setAccessActive(true);
        }}
      />
    </>
  );
}

async function renderHarness({
  initial = createAgentActorDraft("/repo/docs"),
  saveMode,
  startOpen = true,
}: {
  initial?: AgentActorDraft;
  saveMode?: "idle" | "pending" | "failure" | "access";
  startOpen?: boolean;
} = {}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  dom.window.document
    .querySelector<HTMLButtonElement>("#external-create")
    ?.focus();
  const root = createRoot(dom.window.document.getElementById("app")!);
  const { AgentActorEditorDialog } =
    await import("./agent-actor-editor-dialog");
  await act(async () => {
    root.render(
      <JourneyHarness
        Editor={AgentActorEditorDialog}
        initial={initial}
        saveMode={saveMode}
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

async function navigateToReview(dom: JSDOM) {
  await clickButton(dom, "Continue");
  await clickButton(dom, "Continue");
  await clickButton(dom, "Continue");
  expect(currentStep(dom)).toBe("review");
}

function validDraft() {
  const draft = createAgentActorDraft("/repo/docs");
  draft.name = "Documentation Agent";
  return draft;
}

function readyRuntime(draft: AgentActorDraft | null) {
  if (!draft) return { phase: "idle" as const, runtime: {} };
  return {
    phase: "ready" as const,
    runtime: Object.fromEntries(
      draft.adapters.map((binding) => [
        binding.adapter,
        bindingRuntime(binding.adapter, draft.approvalMode === "full"),
      ]),
    ),
  };
}

function bindingRuntime(
  adapter: AgentActorBinding["adapter"],
  full: boolean,
): AgentActorBindingRuntime {
  return {
    approval: {
      danger: full,
      effectiveBoundary:
        adapter === "codex" ? "Codex native boundary" : "Claude full boundary",
      label: full ? "Full access" : "Ask",
      native:
        adapter === "codex"
          ? full
            ? "codex_full_access"
            : "codex_user_review"
          : full
            ? "claude_bypass_permissions"
            : "claude_default",
      requested: full ? "full" : "ask",
    },
    effortOptions: [{ label: "Client default", value: null }],
    validation: { issues: [], status: "valid" },
  };
}

function accessSnapshot() {
  return {
    checkedAt: null,
    expiresAt: null,
    generation: 1,
    lastKnownStatus: null,
    reason: "not_checked" as const,
    repositoryId: "repo-test",
    status: "unknown" as const,
  };
}

function cloneDraft(draft: AgentActorDraft): AgentActorDraft {
  return {
    ...draft,
    adapters: draft.adapters.map((binding) => ({ ...binding })),
  };
}

function currentStep(dom: JSDOM) {
  const journey = dom.window.document.querySelector(
    "[data-agent-actor-create-journey]",
  );
  if (!journey) throw new Error("Agent Actor create journey not found");
  return journey.getAttribute("data-agent-actor-create-step");
}

function findButton(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll("button"),
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
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function createDom() {
  return new JSDOM(
    '<!doctype html><html><body><button id="external-create">Create agent</button><div id=app></div></body></html>',
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
