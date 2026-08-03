import { expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";

import type { ActorIdentityDraft } from "./actor-identity-fields";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { AppliedActorMutationResult } from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";

const source: ActorCatalogRow = {
  aliases: [{ email: "ada@old.test", line: 2, name: "A. Lovelace" }],
  availableYears: [2026],
  canonicalEmail: "ada@example.test",
  commitCount: 4,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: "2026-07-31",
  lastCommitAt: 20,
  sources: [],
};

const target: ActorCatalogRow = {
  aliases: [],
  availableYears: [2026],
  canonicalEmail: "grace@example.test",
  commitCount: 3,
  contribution: "contributor",
  displayName: "Grace Hopper",
  lastActivityDate: "2026-07-30",
  lastCommitAt: 19,
  sources: [],
};

test("identity fields validate and normalize the submitted identity", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { ActorIdentityFields } = await import("./actor-identity-fields");
  const values: ActorIdentityDraft[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <ActorIdentityFields
          initialValue={{ canonicalEmail: "", displayName: "" }}
          pending={false}
          onSubmit={(value) => values.push(value)}
        />,
      );
    });
    const form = dom.window.document.querySelector<HTMLFormElement>(
      "#actor-mutation-form",
    )!;

    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true }));
    });
    expect(dom.window.document.querySelectorAll('[role="alert"]').length).toBe(
      2,
    );
    expect(values).toEqual([]);

    await act(async () => {
      setInputValue(dom, "#actor-mutation-name", "  New Contributor  ");
      setInputValue(dom, "#actor-mutation-email", "  NEW@example.test  ");
    });
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true }));
    });
    expect(values).toEqual([
      {
        canonicalEmail: "NEW@example.test",
        displayName: "New Contributor",
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("merge picker selects one canonical target from the available actors", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { ActorMergePicker } = await import("./actor-merge-picker");
  const selected: string[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <ActorMergePicker
          pending={false}
          rows={[target]}
          selectedEmail={null}
          onSelect={(canonicalEmail) => selected.push(canonicalEmail)}
        />,
      );
    });
    expect(dom.window.document.body.textContent?.includes("Grace Hopper")).toBe(
      true,
    );
    await act(async () => {
      dom.window.document
        .querySelector<HTMLElement>('[data-slot="command-item"]')!
        .click();
    });
    expect(selected).toEqual(["grace@example.test"]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("review shows aliases, current Git identity effects, and mailmap status", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { ActorMutationReviewStep } = await import("./actor-mutation-review");
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <ActorMutationReviewStep
          commitExpectation="manual"
          rootPointerCommitExpectation="automatic_if_safe"
          review={{
            action: {
              canonicalEmail: "ada@canonical.test",
              displayName: "Ada Lovelace",
              kind: "edit",
              sourceCanonicalEmail: source.canonicalEmail,
            },
            affectsCurrentIdentity: true,
            currentIdentityFingerprint: "identity-v1",
            previewFingerprint: "mailmap-v1",
            repositoryId: "actor-repo-test",
            resultCanonicalEmail: "ada@canonical.test",
            resultDisplayName: "Ada Lovelace",
            transferredAliasEmails: [source.canonicalEmail, "ada@old.test"],
          }}
        />,
      );
    });
    expect(
      dom.window.document.body.textContent?.includes("Current Git identity"),
    ).toBe(true);
    expect(dom.window.document.body.textContent?.includes("ada@old.test")).toBe(
      true,
    );
    expect(
      dom.window.document.body.textContent?.includes("remain pending"),
    ).toBe(true);
    expect(
      dom.window.document.body.textContent?.includes(
        "Manual save from this surface will commit the child .mailmap first",
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("mutation state machine applies a reviewed snapshot and opens duplicates", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { useActorMutation } = await import("../hooks/use-actor-mutation");
  const applied: AppliedActorMutationResult[] = [];
  const duplicates: string[] = [];
  const calls: Array<{ args: unknown; command: string }> = [];
  let previewCount = 0;
  const review = {
    action: {
      canonicalEmail: "new@example.test",
      displayName: "New Contributor",
      kind: "add" as const,
    },
    affectsCurrentIdentity: false,
    currentIdentityFingerprint: null,
    previewFingerprint: "mailmap-v1",
    repositoryId: "actor-repo-test",
    resultCanonicalEmail: "new@example.test",
    resultDisplayName: "New Contributor",
    transferredAliasEmails: [],
  };
  mockNativeIpc((command, args) => {
    calls.push({ args, command });
    if (command === "actors_preview_mutation") {
      previewCount += 1;
      return previewCount === 1
        ? {
            commitExpectation: "automatic_if_safe",
            review,
            rootPointerCommitExpectation: "manual",
            status: "ready",
          }
        : { canonicalEmail: source.canonicalEmail, status: "duplicate" };
    }
    if (command === "actors_apply_mutation") {
      return {
        canonicalEmail: "new@example.test",
        catalog: {
          diagnostics: [],
          generation: 2,
          repositoryId: "actor-repo-test",
          rows: [
            {
              aliases: [],
              availableYears: [],
              canonicalEmail: "new@example.test",
              commitCount: 0,
              contribution: "no_commits",
              displayName: "New Contributor",
              lastActivityDate: null,
              lastCommitAt: null,
              sources: [],
            },
          ],
          shallow: false,
        },
        currentIdentityUpdated: false,
        persistence: {
          mailmap: { status: "committed" },
          rootPointer: { reason: "policy_off", status: "pending" },
        },
        status: "applied",
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  function MutationHarness() {
    const mutation = useActorMutation({
      projectPath: "/project",
      spacePath: "/repo",
      onApplied: (result) => {
        applied.push(result);
      },
      onDuplicate: (canonicalEmail) => duplicates.push(canonicalEmail),
    });
    return (
      <>
        <span data-intent>{mutation.intent?.kind ?? "closed"}</span>
        <span data-review>{mutation.review?.resultCanonicalEmail ?? ""}</span>
        <span data-duplicate>{mutation.duplicateEmail ?? ""}</span>
        <span data-session>{mutation.sessionId}</span>
        <button type="button" onClick={mutation.openAdd}>
          open
        </button>
        <button
          type="button"
          onClick={() => void mutation.requestPreview(review.action)}
        >
          preview
        </button>
        <button type="button" onClick={() => void mutation.apply()}>
          apply
        </button>
        <button type="button" onClick={mutation.openDuplicate}>
          duplicate
        </button>
      </>
    );
  }

  try {
    await act(async () => {
      root.render(<MutationHarness />);
    });
    await clickAndFlush(dom, "open");
    expect(textOf(dom, "[data-session]")).toBe("1");
    await clickAndFlush(dom, "preview");
    expect(textOf(dom, "[data-review]")).toBe("new@example.test");
    await clickAndFlush(dom, "apply");
    expect(applied.length).toBe(1);
    expect(applied[0]?.canonicalEmail).toBe("new@example.test");
    expect(applied[0]?.catalog.generation).toBe(2);
    expect(Object.isFrozen(applied[0]?.catalog)).toBe(true);
    expect(applied[0]?.persistence.mailmap.status).toBe("committed");
    expect(applied[0]?.persistence.rootPointer?.status).toBe("pending");
    expect(textOf(dom, "[data-intent]")).toBe("closed");

    await clickAndFlush(dom, "open");
    expect(textOf(dom, "[data-session]")).toBe("2");
    await clickAndFlush(dom, "preview");
    expect(textOf(dom, "[data-duplicate]")).toBe(source.canonicalEmail);
    await clickAndFlush(dom, "duplicate");
    expect(duplicates).toEqual([source.canonicalEmail]);
    expect(textOf(dom, "[data-intent]")).toBe("closed");
    expect(calls.map((call) => call.command)).toEqual([
      "actors_preview_mutation",
      "actors_apply_mutation",
      "actors_preview_mutation",
    ]);
    const applyArgs = calls[1]?.args as {
      projectPath: string;
      spacePath: string;
    };
    expect(applyArgs.projectPath).toBe("/project");
    expect(applyArgs.spacePath).toBe("/repo");
    const previewArgs = calls[0]?.args as {
      projectPath: string;
      spacePath: string;
    };
    expect(previewArgs.projectPath).toBe("/project");
    expect(previewArgs.spacePath).toBe("/repo");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

async function clickAndFlush(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll("button"),
  ).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function setInputValue(dom: JSDOM, selector: string, value: string) {
  const input = dom.window.document.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  const scrollIntoView = () => undefined;
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
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
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FormData: dom.window.FormData,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
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
